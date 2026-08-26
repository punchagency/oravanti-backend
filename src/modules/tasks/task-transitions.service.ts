import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { staff } from "../../db/schema/staff";
import { tasks } from "../../db/schema/tasks";
import { createModuleLogger } from "../../lib/logging/log";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { logLeadEvent } from "../leads/lead-events.service";
import {
  getTaskReviewEvents,
  recordTaskReviewEvent,
} from "../shared/task-review-events.service";
import {
  assignableStaff,
  getCaseTeamId,
} from "../workflow/assignment.service";
import { WorkflowService } from "../workflow/workflow.service";

const log = createModuleLogger("tasks.transitions");

/**
 * The task lifecycle, for every task in the system.
 *
 * There used to be two of these — one under `/leads/:leadId/tasks/*` for intake
 * steps and one under `/workflow/cases/:caseId/steps/*` for case steps — with
 * the same four review verbs, the same state machine spelled out twice, and two
 * sets of error messages that had already drifted ("Only tasks in review can be
 * approved" vs "Step must be in_review to approve"). They operate on one table,
 * so they are one surface now: `/tasks/:id/<verb>`.
 *
 * What stays different is what a transition *means* to the thing it hangs off.
 * A case step carries a case timeline entry, an elapsed-time measurement and a
 * step note; an intake step carries a lead timeline entry. That difference is
 * real, so this dispatches to `WorkflowService` for `source: "workflow"` rather
 * than reimplementing it — one entry point, no lost behaviour, and the case
 * workflow's own endpoints keep working for the workflow tab that returns the
 * whole tree.
 */

export type TaskTransition = "start" | "complete" | "submit" | "approve" | "reject" | "reopen";

/** What a transition does to the `completedBy`/`completedAt` pair. */
type Completion = "claim" | "clear";

interface TransitionRule {
  /** Statuses the task may be in. Empty means any. */
  from: readonly string[];
  to: "in_review" | "completed" | "rejected" | "in_progress";
  completion: Completion;
  /** The review-thread verb — an `AUDIT_ACTIONS` name, stored and read back as-is. */
  reviewAction: "task.submitted" | "task.approved" | "task.rejected" | "task.reopened" | null;
  /** The lead timeline verb, used only when the task hangs off a lead. */
  leadAction:
    | "lead.task_status_changed"
    | "lead.task_completed"
    | "lead.task_submitted_for_review"
    | "lead.task_approved"
    | "lead.task_rejected"
    | "lead.task_reopened";
  /** Shown when `from` does not match. Phrased for whoever pressed the button. */
  refusal: string;
  /** Whether the note is the point of the transition rather than a remark on it. */
  requiresNote: boolean;
}

const TRANSITIONS: Record<TaskTransition, TransitionRule> = {
  start: {
    /*
      The move that was missing.

      A task arrives `pending` — assigned to someone, not yet picked up — and
      this is how the person holding it says they have begun. Nothing else may
      move it: materialization used to stamp `in_progress` at assignment, which
      is the whole reason "in progress" had stopped meaning anything.

      Not a review event, so no `reviewAction`: the review thread stays about
      what reviewers said. `completion: "clear"` because starting a task is the
      opposite of finishing one — if it is being restarted after a wrong
      completion, the stale `completedBy` must not survive.
    */
    from: ["pending"],
    to: "in_progress",
    completion: "clear",
    reviewAction: null,
    leadAction: "lead.task_status_changed",
    refusal: "Only a task that has not been started yet can be started",
    requiresNote: false,
  },
  complete: {
    from: [],
    to: "completed",
    completion: "claim",
    // Completing without a review round is not a review event — the timeline
    // records it, the review thread stays about what reviewers said.
    reviewAction: null,
    leadAction: "lead.task_completed",
    refusal: "",
    requiresNote: false,
  },
  submit: {
    // A rejected task is resubmitted straight from here rather than forcing a
    // separate reopen round trip.
    from: ["in_progress", "rejected"],
    to: "in_review",
    completion: "claim",
    reviewAction: "task.submitted",
    leadAction: "lead.task_submitted_for_review",
    refusal: "Only in-progress or rejected tasks can be submitted for review",
    requiresNote: false,
  },
  approve: {
    from: ["in_review"],
    to: "completed",
    completion: "claim",
    reviewAction: "task.approved",
    leadAction: "lead.task_approved",
    refusal: "Only tasks in review can be approved",
    requiresNote: false,
  },
  reject: {
    // Terminal until someone acts on the feedback: dropping straight back to
    // `in_progress` gave the assignee no signal that anything had been rejected.
    from: ["in_review"],
    to: "rejected",
    completion: "clear",
    reviewAction: "task.rejected",
    leadAction: "lead.task_rejected",
    refusal: "Only tasks in review can be rejected",
    requiresNote: true,
  },
  reopen: {
    // Also from `completed` and `skipped`: work gets marked done in error, or
    // skipped and then turns out to matter, and a closed step with no way back
    // forces the firm to either live with a wrong record or raise a duplicate
    // task beside it. Reopening is audited like every other move, so the
    // correction is visible rather than silent.
    from: ["rejected", "completed", "skipped"],
    to: "in_progress",
    completion: "clear",
    reviewAction: "task.reopened",
    leadAction: "lead.task_reopened",
    refusal: "Only rejected, completed or skipped tasks can be reopened",
    requiresNote: false,
  },
};

/**
 * Whether `task` may take `transition`, as a message or null.
 *
 * Pure and exported for its own test: this is the whole state machine, and it is
 * worth pinning down without a database behind it.
 */
export function transitionViolation(
  task: { status: string },
  transition: TaskTransition,
  note: string | undefined,
): string | null {
  const rule = TRANSITIONS[transition];

  if (rule.from.length > 0 && !rule.from.includes(task.status)) return rule.refusal;
  if (rule.requiresNote && !note?.trim()) {
    return `Rejecting a task needs feedback saying what to fix`;
  }
  return null;
}

/**
 * Which half of the review thread a task's rows live under.
 *
 * The kind is stored as the audit row's `entity_type` and reads filter on it, so
 * it has to be derived the same way on write and on read — which is why it is
 * this one function and not an argument any caller can get wrong.
 */
const reviewKindFor = (source: string) =>
  source === "workflow" ? ("case_step" as const) : ("lead_task" as const);

/** One task's full submit → approve/reject → reopen thread, oldest first. */
export async function getReviewThread(taskId: string, organizationId: string) {
  const task = await loadTask(taskId, organizationId);
  return getTaskReviewEvents(reviewKindFor(task.source), task.id, organizationId);
}

async function loadTask(taskId: string, organizationId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
    .limit(1);

  if (!task) throw new NotFoundError("Task not found");
  return task;
}

const workflowService = new WorkflowService();

/**
 * The case-side handler for each verb.
 *
 * Named methods rather than a generic call so the compiler still checks the
 * argument order — every one of these takes `(caseId, stepId, organizationId,
 * performedById, note)` today, and a silent reordering would send a note where
 * an actor belongs.
 */
const WORKFLOW_HANDLERS: Record<
  TaskTransition,
  (caseId: string, stepId: string, organizationId: string, actorId?: string, note?: string) => Promise<unknown>
> = {
  start: (c, s, o, a, n) => workflowService.startStep(c, s, o, a, n),
  complete: (c, s, o, a, n) => workflowService.completeStep(c, s, o, a, n),
  submit: (c, s, o, a, n) => workflowService.submitForReview(c, s, o, a, n),
  approve: (c, s, o, a, n) => workflowService.approveStep(c, s, o, a, n),
  reject: (c, s, o, a, n) => workflowService.rejectStep(c, s, o, a, n),
  reopen: (c, s, o, a, n) => workflowService.reopenStep(c, s, o, a, n),
};

export interface TransitionParams {
  taskId: string;
  organizationId: string;
  transition: TaskTransition;
  actorStaffId?: string | null;
  note?: string;
}

/** Moves one task through the lifecycle and records it wherever it belongs. */
export async function transitionTask(params: TransitionParams) {
  const task = await loadTask(params.taskId, params.organizationId);

  if (task.source === "workflow") {
    if (!task.caseId) {
      throw new BadRequestError("This workflow step is not attached to a case");
    }
    // The case path validates the same transitions itself, with the case
    // timeline, elapsed time and step note the workflow tab reads back.
    await WORKFLOW_HANDLERS[params.transition](
      task.caseId,
      task.id,
      params.organizationId,
      params.actorStaffId ?? undefined,
      params.note,
    );
    return loadTask(params.taskId, params.organizationId);
  }

  const violation = transitionViolation(task, params.transition, params.note);
  if (violation) {
    log.warn("task.transition_refused", {
      taskId: task.id,
      transition: params.transition,
      status: task.status,
    });
    throw new BadRequestError(violation);
  }

  const rule = TRANSITIONS[params.transition];
  const now = new Date();

  const [updated] = await db
    .update(tasks)
    .set({
      status: rule.to,
      completedById: rule.completion === "claim" ? (params.actorStaffId ?? null) : null,
      completedAt: rule.completion === "claim" ? now : null,
      updatedAt: now,
    })
    .where(and(eq(tasks.id, task.id), eq(tasks.organizationId, params.organizationId)))
    .returning();

  if (rule.reviewAction) {
    await recordTaskReviewEvent({
      organizationId: params.organizationId,
      taskKind: reviewKindFor(task.source),
      taskId: task.id,
      leadId: task.leadId,
      action: rule.reviewAction,
      note: params.note,
      actorId: params.actorStaffId,
    });
  }

  if (task.leadId) {
    await logLeadEvent({
      organizationId: params.organizationId,
      leadId: task.leadId,
      action: rule.leadAction,
      actorId: params.actorStaffId,
      metadata: { taskId: task.id, title: task.title, note: params.note?.trim() || null },
    });
  }

  log.action("task.transitioned", {
    taskId: task.id,
    transition: params.transition,
    from: task.status,
    to: rule.to,
  });

  return updated;
}

/**
 * Everyone this task may be handed to.
 *
 * A case task draws from the team the case is assigned to and nowhere else — a
 * firm that has committed a matter to a team should not be able to route that
 * matter's work outside it, whether the routing is automatic or by hand. An
 * intake step hangs off a lead, which has no team, so it draws from the firm.
 */
export async function assignableStaffForTask(taskId: string, organizationId: string) {
  const task = await loadTask(taskId, organizationId);
  return assignableStaff({
    organizationId,
    teamId: task.caseId ? await getCaseTeamId(organizationId, task.caseId) : null,
  });
}

/**
 * Hands a task to a specific person.
 *
 * Separate from `transitionTask` because it is not a lifecycle move: a task can
 * be reassigned in any status, and reassigning does not start, finish or review
 * anything.
 */
export async function assignTask(params: {
  taskId: string;
  assignedToId: string;
  organizationId: string;
  actorStaffId?: string | null;
  /** Required to reassign a locked step — see `assignStep`. */
  overrideRationale?: string;
}) {
  const task = await loadTask(params.taskId, params.organizationId);

  // A case's work stays on the case's team, whoever is doing the assigning. The
  // picker only offers team members, but the check belongs here too — the id
  // decides who gets the work, and nothing else on this path validates it. This
  // also covers firm membership, since the pool is scoped by organization.
  const pool = await assignableStaffForTask(params.taskId, params.organizationId);
  if (!pool.some((s) => s.id === params.assignedToId)) {
    throw new BadRequestError(
      task.caseId
        ? "That staff member is not on the team this case is assigned to"
        : "That staff member cannot take this task",
    );
  }

  if (task.source === "workflow") {
    if (!task.caseId) {
      throw new BadRequestError("This workflow step is not attached to a case");
    }
    await workflowService.assignStep(
      task.caseId,
      task.id,
      params.assignedToId,
      params.organizationId,
      params.overrideRationale,
      params.actorStaffId ?? undefined,
    );
    return loadTask(params.taskId, params.organizationId);
  }

  const [updated] = await db
    .update(tasks)
    .set({ assignedToId: params.assignedToId, assignedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.organizationId, params.organizationId)))
    .returning();

  if (task.leadId) {
    const [assignee] = await db
      .select({ name: sql<string>`concat(${staff.firstName}, ' ', ${staff.lastName})` })
      .from(staff)
      .where(
        and(
          eq(staff.id, params.assignedToId),
          eq(staff.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    await logLeadEvent({
      organizationId: params.organizationId,
      leadId: task.leadId,
      action: "lead.task_assigned",
      actorId: params.actorStaffId,
      metadata: {
        taskId: task.id,
        title: task.title,
        assignedToId: params.assignedToId,
        assigneeName: assignee?.name,
      },
    });
  }

  log.action("task.assigned", { taskId: task.id, assignedToId: params.assignedToId });

  return updated;
}
