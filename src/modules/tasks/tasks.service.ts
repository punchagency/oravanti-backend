import { and, asc, count, desc, eq, gte, lte, or } from "drizzle-orm";
import { db } from "../../db/client";
import type { UpdateTaskInput } from "./tasks.validation";
import { admins, cases, clients, staff, tasks } from "../../db/schema";
import { notify } from "../../notifications/notification.service";
import { assertAssignableStaff } from "../../utils/assignable-staff";
import { BadRequestError } from "../../utils/error/app-error";
import { dayjs } from "../../utils/date";
import { logLeadEvent } from "../leads/lead-events.service";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { myTasksUrl } from "../../lib/app-links";

const log = createModuleLogger("tasks.service");

/**
 * Fields on a locked step that a firm cannot change without saying why.
 *
 * The locked backbone exists so a firm's own edits can't quietly remove a
 * deadline the practice depends on — so it is the *deadline-bearing* fields
 * that are protected, not the whole row. Renaming a locked step or reassigning
 * it is ordinary case work and needs no ceremony.
 */
const LOCKED_PROTECTED_FIELDS = ["dueDate", "requiredCertifications"] as const;

/** Statuses that end a locked step without the work having been done. */
const LOCKED_PROTECTED_STATUSES = ["skipped", "cancelled"] as const;

/**
 * The reason this patch needs an `overrideRationale`, or `null` if it doesn't.
 *
 * Returns the message rather than a boolean so the 400 can say which field
 * triggered it — "Task is locked" alone leaves the caller guessing which part
 * of their patch to drop.
 *
 * Pure and exported for its own test: this predicate is the whole locked-
 * backbone guarantee, and it is worth pinning down without a database.
 */
export function lockedOverrideViolation(
  task: { isLocked: boolean },
  patch: UpdateTaskInput,
): string | null {
  if (!task.isLocked || patch.overrideRationale) return null;

  const field = LOCKED_PROTECTED_FIELDS.find((f) => patch[f] !== undefined);
  if (field) {
    return `${field} is locked on this step — provide an overrideRationale to change it`;
  }

  if (patch.status && (LOCKED_PROTECTED_STATUSES as readonly string[]).includes(patch.status)) {
    return `This step is locked — provide an overrideRationale to mark it ${patch.status}`;
  }

  return null;
}

/**
 * Which audit action a task update belongs under.
 *
 * A workflow-sourced task IS a case step, and its lifecycle belongs in the
 * matter's timeline under the `case.step_*` vocabulary — `case.task_*` is for
 * ad-hoc work. Same row in the same table; different thing to someone reading
 * the timeline. See the note above `case.task_created` in lib/audit/actions.ts.
 */
function auditActionFor(source: string, status: string | undefined) {
  if (source !== "workflow") return "case.task_updated" as const;

  switch (status) {
    case "completed":
      return "case.step_completed" as const;
    case "skipped":
      return "case.step_skipped" as const;
    default:
      return "case.step_updated" as const;
  }
}

/**
 * Which lead-timeline verb a patch on a lead-attached task belongs under.
 *
 * A lead's timeline is read by intake staff who never see the audit table, so a
 * status change has to say it changed status. Anything else is an edit.
 */
function leadActionFor(status: string | undefined) {
  return status ? ("lead.task_status_changed" as const) : ("lead.task_updated" as const);
}

export class TasksService {
  // ─── Stats ───────────────────────────────────────────────────────────────────

  getTaskStats = async (organizationId: string) => {
    const [activeResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
        ),
      );

    // "This week" is bounded by the firm's local calendar week.
    const tz = await getFirmTimezone(organizationId);
    const weekStart = dayjs().tz(tz).startOf("week");
    const startOfWeek = weekStart.utc().toDate();
    const endOfWeek = weekStart.endOf("week").utc().toDate();

    const [completedResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          eq(tasks.status, "completed"),
          gte(tasks.updatedAt, startOfWeek),
        ),
      );

    const [highPriorityResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          or(eq(tasks.priority, "high"), eq(tasks.priority, "critical")),
          or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
        ),
      );

    const todayStr = new Date().toISOString().split("T")[0];
    const endOfWeekStr = endOfWeek.toISOString().split("T")[0];

    const [dueThisWeekResult] = await db
      .select({ count: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, organizationId),
          gte(tasks.dueDate, todayStr),
          lte(tasks.dueDate, endOfWeekStr),
          or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
        ),
      );

    return {
      activeTasks: activeResult.count,
      completedThisWeek: completedResult.count,
      highPriority: highPriorityResult.count,
      dueThisWeek: dueThisWeekResult.count,
    };
  };

  // ─── Shared select + joins ────────────────────────────────────────────────────

  taskSelect = {
    id: tasks.id,
    title: tasks.title,
    description: tasks.description,
    // Staff-facing guidance, snapshotted from the template step. Sent with the
    // task itself rather than fetched from the template on demand: the point of
    // snapshotting is that the person doing the work reads what was written for
    // the work as handed out, and a second round-trip invites a client to
    // render the current template's wording instead.
    purpose: tasks.purpose,
    guidance: tasks.guidance,
    doneWhen: tasks.doneWhen,
    pitfalls: tasks.pitfalls,
    authority: tasks.authority,
    teamId: tasks.teamId,
    dueDate: tasks.dueDate,
    priority: tasks.priority,
    status: tasks.status,
    requiredCertifications: tasks.requiredCertifications,
    // Workflow-engine fields. `phase` is the denormalized display grouping (a
    // module is template-time, phase survives even for ad-hoc tasks with no
    // module at all); `isLocked` drives the override-with-rationale path.
    source: tasks.source,
    phase: tasks.phase,
    orderIndex: tasks.orderIndex,
    isRequired: tasks.isRequired,
    isLocked: tasks.isLocked,
    // Lets a client map a materialized task back to the template step it came
    // from — which is how the workflow tab knows a module's steps are present
    // and, by their absence, that a conditional module hasn't activated yet.
    workflowTemplateStepId: tasks.workflowTemplateStepId,
    leadId: tasks.leadId,
    notes: tasks.notes,
    overrideRationale: tasks.overrideRationale,
    createdAt: tasks.createdAt,
    updatedAt: tasks.updatedAt,
    caseId: cases.id,
    caseNumber: cases.caseNumber,
    caseTypeId: cases.caseTypeId,
    clientId: clients.id,
    clientDisplayName: clients.displayName,
    assignedToId: staff.id,
    assignedToFirstName: staff.firstName,
    assignedToLastName: staff.lastName,
    assignedToRole: staff.role,
    assignedByFirstName: admins.firstName,
    assignedByLastName: admins.lastName,
  };

  withJoins = (query: any) =>
    query
      .leftJoin(cases, eq(cases.id, tasks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .leftJoin(staff, eq(staff.id, tasks.assignedToId))
      .leftJoin(admins, eq(admins.id, tasks.assignedById));

  formatRow = (r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    // Guidance travels with the task. `guidance` is coalesced to an array
    // because a task predating these columns reads back null, and the client
    // treats this as a list it can measure and map without checking first.
    purpose: r.purpose ?? null,
    guidance: r.guidance ?? [],
    doneWhen: r.doneWhen ?? null,
    pitfalls: r.pitfalls ?? null,
    authority: r.authority ?? null,
    teamId: r.teamId,
    dueDate: r.dueDate,
    priority: r.priority,
    status: r.status,
    requiredCertifications: r.requiredCertifications,
    source: r.source,
    phase: r.phase,
    orderIndex: r.orderIndex,
    isRequired: r.isRequired,
    isLocked: r.isLocked,
    workflowTemplateStepId: r.workflowTemplateStepId,
    leadId: r.leadId,
    notes: r.notes,
    overrideRationale: r.overrideRationale,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    case: {
      id: r.caseId,
      caseNumber: r.caseNumber,
      caseType: r.caseTypeId,
    },
    client: {
      id: r.clientId,
      name: r.clientDisplayName ?? '',
    },
    assignedTo: r.assignedToId
      ? {
          id: r.assignedToId,
          name: `${r.assignedToFirstName} ${r.assignedToLastName}`,
          role: r.assignedToRole,
        }
      : null,
    assignedBy: r.assignedByFirstName
      ? { name: `${r.assignedByFirstName} ${r.assignedByLastName}` }
      : null,
  });

  // ─── Tasks CRUD ───────────────────────────────────────────────────────────────

  getAllTasks = async (
    organizationId: string,
    filters?: {
      search?: string;
      status?: string;
      priority?: string;
      assignedToId?: string;
      /** Scope to one matter — the case workflow tab's access path. */
      caseId?: string;
      /** Scope to one lead — the intake pipeline board's access path. */
      leadId?: string;
      /** `workflow` | `pipeline` | `ad_hoc`; omit for every source. */
      source?: "workflow" | "pipeline" | "ad_hoc";
    },
  ) => {
    // Scoping filters go in SQL, not the in-memory pass below: a case's
    // workflow is ~135 tasks out of a firm's tens of thousands, and fetching
    // the firm to filter down to one matter does not stay viable.
    const scope = [
      eq(tasks.organizationId, organizationId),
      ...(filters?.caseId ? [eq(tasks.caseId, filters.caseId)] : []),
      ...(filters?.leadId ? [eq(tasks.leadId, filters.leadId)] : []),
      ...(filters?.source ? [eq(tasks.source, filters.source)] : []),
    ];

    const rows = await this.withJoins(db.select(this.taskSelect).from(tasks))
      .where(and(...scope))
      // Workflow steps run in template order; ad-hoc tasks have no orderIndex,
      // so Postgres sorts those NULLs last and they fall back to newest-first.
      .orderBy(asc(tasks.orderIndex), desc(tasks.createdAt));

    return rows
      .filter((r: any) => {
        if (filters?.status && r.status !== filters.status) return false;
        if (filters?.priority && r.priority !== filters.priority) return false;
        if (filters?.assignedToId && r.assignedToId !== filters.assignedToId)
          return false;
        if (filters?.search) {
          const q = filters.search.toLowerCase();
          const matches =
            r.title.toLowerCase().includes(q) ||
            r.clientFirstName?.toLowerCase().includes(q) ||
            r.clientLastName?.toLowerCase().includes(q) ||
            r.caseType?.toLowerCase().includes(q) ||
            r.caseNumber?.toLowerCase().includes(q);
          if (!matches) return false;
        }
        return true;
      })
      .map(this.formatRow);
  };

  getTaskById = async (id: string, organizationId: string) => {
    const [row] = await this.withJoins(
      db.select(this.taskSelect).from(tasks),
    ).where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));

    return row ? this.formatRow(row) : null;
  };

  createTask = async (data: {
    organizationId: string;
    title: string;
    description: string;
    caseId: string;
    teamId?: string;
    assignedToId: string;
    assignedById: string;
    dueDate: string;
    priority?: string;
    requiredCertifications?: string[];
  }) => {
    await assertAssignableStaff(data.assignedToId, data.organizationId);

    const [newTask] = await db
      .insert(tasks)
      .values({
        organizationId: data.organizationId,
        source: "ad_hoc",
        title: data.title,
        description: data.description,
        caseId: data.caseId,
        teamId: data.teamId,
        assignedToId: data.assignedToId,
        assignedById: data.assignedById,
        dueDate: data.dueDate,
        priority: (data.priority ?? "medium") as any,
        requiredCertifications: data.requiredCertifications ?? [],
      })
      .returning();

    void notifyTaskAssignee(newTask, data.assignedById);
    await recordAuditEvent({
      action: "case.task_created",
      entityId: newTask.id,
      parentEntityType: "case",
      parentEntityId: data.caseId,
      summary: `Task created: ${newTask.title}`,
      after: { title: newTask.title, status: newTask.status, priority: newTask.priority },
      onWriteFailure: "log",
    });

    log.action("task.created", { taskId: newTask.id });

    return newTask;
  };

  updateTask = async (
    id: string,
    organizationId: string,
    data: UpdateTaskInput,
    actorStaffId?: string | null,
  ) => {
    // One read, serving both callers below: the locked-step override check
    // needs the lock flag and provenance, and telling a reassignment from an
    // edit that merely mentions the same assignee needs the current assignee.
    const [existing] = await db
      .select({
        isLocked: tasks.isLocked,
        source: tasks.source,
        leadId: tasks.leadId,
        status: tasks.status,
        assignedToId: tasks.assignedToId,
      })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)))
      .limit(1);

    if (!existing) return null;

    const violation = lockedOverrideViolation(existing, data);
    if (violation) throw new BadRequestError(violation);

    const { overrideRationale, ...patch } = data;

    // Stamp the override trail only when there was something to override. A
    // rationale sent alongside an unprotected edit is accepted but not recorded
    // as one — an override trail full of entries that overrode nothing is worse
    // than no trail.
    const overriding = existing.isLocked && overrideRationale !== undefined;

    const [updated] = await db
      .update(tasks)
      .set({
        ...patch,
        updatedAt: new Date(),
        ...(overriding
          ? {
              overrideRationale,
              overrideById: actorStaffId ?? null,
              overrideAt: new Date(),
            }
          : {}),
      })
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)))
      .returning();

    /*
      No assignee notification here.

      `updateTaskBody` deliberately does not accept `assignedToId` — assignment
      has its own endpoint with its own rules (a case task may only go to
      someone on the case's team), and two ways to assign is the drift that
      consolidating these tables was meant to end. This hook arrived on a branch
      where a generic patch could still reassign; on this one it could never
      fire, so it lives on the assignment path instead. See `assignTask` in
      task-transitions.service.ts.
    */

    if (updated) {
      await recordAuditEvent({
        action: auditActionFor(existing.source, patch.status),
        entityId: updated.id,
        // A lead-attached task has no case to parent onto. Sending one anyway
        // filed intake work under a null matter, where nothing could find it.
        parentEntityType: updated.caseId ? "case" : updated.leadId ? "lead" : undefined,
        parentEntityId: updated.caseId ?? updated.leadId ?? undefined,
        organizationId,
        actor: actorStaffId ? { staffId: actorStaffId } : undefined,
        summary: overriding
          ? `Locked step overridden: ${updated.title} — ${overrideRationale}`
          : `Task updated: ${updated.title}`,
        after: { title: updated.title, status: updated.status, priority: updated.priority },
        metadata: overriding ? { overrideRationale } : undefined,
        onWriteFailure: "log",
      });

      // The lead's own timeline, which intake staff read instead of the audit
      // table. Only for tasks that hang off a lead — a case step has the case
      // timeline, written by the workflow service.
      if (updated.leadId) {
        await logLeadEvent({
          organizationId,
          leadId: updated.leadId,
          action: leadActionFor(patch.status),
          actorId: actorStaffId,
          metadata: {
            taskId: updated.id,
            title: updated.title,
            ...(patch.status ? { from: existing.status, to: patch.status } : { changes: patch }),
          },
        });
      }
    }

    log.action("task.updated", { taskId: id, overriding });

    return updated ?? null;
  };

  deleteTask = async (id: string, organizationId: string) => {
    await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));

    log.action("task.deleted", { taskId: id });
  };
}

/**
 * Tell someone a task landed on them.
 *
 * Nothing did this before: tasks were created and reassigned entirely
 * silently, and the assignee found out by opening the app. Preference-gated
 * under `case_stage_changed`, and email/in-app only — a task is not worth a
 * text message.
 *
 * Never notifies someone about their own action: assigning yourself a task is
 * not news to you.
 *
 * Module scope rather than a private method because assignment does not happen
 * in this file. `assignTask` (task-transitions.service.ts) is the one endpoint
 * that hands work to a person, and it needs to call this too.
 */
export const notifyTaskAssignee = async (
  task: typeof tasks.$inferSelect,
  assignedById: string | null,
) => {
  {
    if (!task.assignedToId || task.assignedToId === assignedById) return;

    try {
      const assigner = assignedById
        ? (
            await db
              .select({ firstName: staff.firstName, lastName: staff.lastName })
              .from(staff)
              .where(eq(staff.id, assignedById))
              .limit(1)
          )[0]
        : undefined;

      await notify({
        organizationId: task.organizationId,
        event: "task_assigned",
        recipients: [{ type: "staff", id: task.assignedToId }],
        context: {
          taskTitle: task.title,
          dueDate: task.dueDate,
          ...(assigner
            ? {
                assignedBy: `${assigner.firstName} ${assigner.lastName}`.trim(),
              }
            : {}),
          // There is no per-task page. The assignee's queue is what this
          // notification is really about anyway.
          link: myTasksUrl(task),
        },
        scenario: { caseId: task.caseId ?? undefined },
        actorStaffId: assignedById,
        // Keyed on the assignee, so a reassignment back to someone who held it
        // before still tells them.
        dedupeKey: `task-assigned-${task.id}-${task.assignedToId}`,
      });
    } catch (err) {
      log.failure(LogEvent.NOTIFICATION_DISPATCH_FAILED, err, {
        taskId: task.id,
        event: "task_assigned",
      });
    }
  }
};
