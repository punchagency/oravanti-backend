import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { staff } from "../../db/schema/staff";
import { tasks, taskStatusEnum } from "../../db/schema/tasks";
import { workflowModules, workflowTemplateSteps } from "../../db/schema/workflow";

/**
 * The cross-entity task lists: the review queue, and one person's own tasks.
 *
 * There used to be four of these on four shapes — an intake review queue
 * (`{ id, pipelineStage, leadName, … }`), a case review queue (`{ stepId,
 * moduleName, caseTitle, … }`), and a "my tasks" for each — over rows of the
 * same table. Four shapes meant four card components, and they had already
 * drifted: only one queue grew a Rejected tab, only one list showed the review
 * thread, and the case queue silently dropped any step whose template row had
 * been replaced (it inner-joined the template).
 *
 * One query, one shape, `source` as the discriminator. `lead` is populated for
 * an intake step and `case` for a workflow step; a client renders whichever is
 * there. The alternative — a lowest-common-denominator row with neither — would
 * make the list unreadable, since "whose task is this?" is the first thing
 * anyone needs from it.
 */

export type TaskSource = "workflow" | "pipeline" | "ad_hoc";
export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];

/** What the review queue shows when the caller names no status. */
const REVIEW_STATUSES: TaskStatus[] = ["in_review", "rejected", "completed"];

/**
 * Zeroes for every status.
 *
 * Callers that short-circuit before querying still send a full counts object —
 * the client indexes it per tab badge, and a missing key there reads as a
 * crash rather than a zero.
 */
export const emptyTaskCounts = (): Record<TaskStatus, number> =>
  Object.fromEntries(taskStatusEnum.enumValues.map((s) => [s, 0])) as Record<
    TaskStatus,
    number
  >;

const assigner = alias(staff, "assigner");
const submitter = alias(staff, "submitter");

/**
 * A person's display name, or null when the row was never joined.
 *
 * Takes the two columns rather than the table so it also works for the aliases
 * above — `typeof staff` would exclude them, since an alias is a distinct type.
 * `nullif(trim(...))` is what turns a missed left join into a clean null instead
 * of a lone space.
 */
const fullName = (first: PgColumn, last: PgColumn) =>
  sql<string | null>`nullif(trim(concat(${first}, ' ', ${last})), '')`;

/**
 * Parses the `status` query parameter.
 *
 * Unknown values are dropped rather than rejected: a stale bookmark naming a
 * status that no longer exists should show the default list, not a 400.
 */
export function parseStatuses(
  status: string | undefined,
  fallback: TaskStatus[],
): TaskStatus[] {
  if (!status) return fallback;

  const valid = new Set<string>(taskStatusEnum.enumValues);
  const parsed = status
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as TaskStatus[];

  return parsed.length > 0 ? parsed : fallback;
}

export interface TaskQueueParams {
  organizationId: string;
  source: TaskSource;
  /** Comma-separated statuses. Defaults per queue — see `getReviewQueue` / `getMyTasks`. */
  status?: string;
  /** Set for "my tasks": the same queue narrowed to one person. */
  assignedToId?: string;
  page?: number;
  limit?: number;
}

/** Tasks that have been through, or are waiting on, review. */
export function getReviewQueue(params: TaskQueueParams) {
  return taskQueue(params, {
    statuses: parseStatuses(params.status, REVIEW_STATUSES),
    // Longest-waiting first: a review queue is worked from the top.
    order: desc(tasks.updatedAt),
  });
}

/**
 * One person's tasks.
 *
 * No status default — an assignee's list starts as everything on their plate,
 * and the tabs narrow it.
 */
export function getMyTasks(params: TaskQueueParams) {
  return taskQueue(params, {
    statuses: parseStatuses(params.status, []),
    // Working order, not arrival order: this is a to-do list.
    order: asc(tasks.phase),
  });
}

async function taskQueue(
  params: TaskQueueParams,
  opts: { statuses: TaskStatus[]; order: ReturnType<typeof desc> },
) {
  const page = Math.max(params.page ?? 1, 1);
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = (page - 1) * limit;

  const inScope = and(
    eq(tasks.organizationId, params.organizationId),
    eq(tasks.source, params.source),
    params.assignedToId ? eq(tasks.assignedToId, params.assignedToId) : undefined,
  );

  // Counts cover every status, not just the ones being listed — they feed the
  // tab badges, which have to be right on the tab you are *not* looking at.
  const countRows = await db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(inScope)
    .groupBy(tasks.status);

  const counts = Object.fromEntries(
    taskStatusEnum.enumValues.map((s) => [
      s,
      countRows.find((r) => r.status === s)?.n ?? 0,
    ]),
  ) as Record<TaskStatus, number>;

  const listed =
    opts.statuses.length > 0
      ? and(inScope, inArray(tasks.status, opts.statuses))
      : inScope;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: tasks.id,
        source: tasks.source,
        title: tasks.title,
        description: tasks.description,
        purpose: tasks.purpose,
        guidance: tasks.guidance,
        doneWhen: tasks.doneWhen,
        pitfalls: tasks.pitfalls,
        authority: tasks.authority,
        status: tasks.status,
        phase: tasks.phase,
        orderIndex: tasks.orderIndex,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        isRequired: tasks.isRequired,
        isLocked: tasks.isLocked,
        notes: tasks.notes,
        // When the row last moved. For an `in_review` row that is when it was
        // submitted, which is what the queue sorts and ages by.
        updatedAt: tasks.updatedAt,
        createdAt: tasks.createdAt,
        assignedAt: tasks.assignedAt,
        completedAt: tasks.completedAt,
        timeTakenMs: tasks.timeTakenMs,
        assignedToId: tasks.assignedToId,
        assignedToName: fullName(staff.firstName, staff.lastName),
        assignedToRole: staff.role,
        assignedByName: fullName(assigner.firstName, assigner.lastName),
        submittedById: tasks.completedById,
        submittedByName: fullName(submitter.firstName, submitter.lastName),
        leadId: tasks.leadId,
        leadName: fullName(leads.firstName, leads.lastName),
        leadEmail: leads.email,
        leadStage: leads.pipelineStage,
        caseId: tasks.caseId,
        caseNumber: cases.caseNumber,
        clientName: clients.displayName,
        moduleName: workflowModules.name,
      })
      .from(tasks)
      .leftJoin(staff, eq(staff.id, tasks.assignedToId))
      .leftJoin(assigner, eq(assigner.id, tasks.assignedById))
      .leftJoin(submitter, eq(submitter.id, tasks.completedById))
      .leftJoin(leads, eq(leads.id, tasks.leadId))
      .leftJoin(cases, eq(cases.id, tasks.caseId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      // Left, not inner: a step whose template row was since replaced still
      // belongs in the list. The old case query inner-joined these and silently
      // dropped such rows.
      .leftJoin(
        workflowTemplateSteps,
        eq(workflowTemplateSteps.id, tasks.workflowTemplateStepId),
      )
      .leftJoin(workflowModules, eq(workflowModules.id, workflowTemplateSteps.moduleId))
      .where(listed)
      .orderBy(opts.order, asc(tasks.orderIndex))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(tasks).where(listed),
  ]);

  const rejections = await latestRejections(
    rows.map((r) => r.id),
    params.organizationId,
  );

  return {
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      description: r.description,
      // Same five fields the task list sends, so a step read from someone's own
      // queue carries the guidance it carries on the case board.
      purpose: r.purpose ?? null,
      guidance: r.guidance ?? [],
      doneWhen: r.doneWhen ?? null,
      pitfalls: r.pitfalls ?? null,
      authority: r.authority ?? null,
      status: r.status,
      /** Intake stage or workflow phase — the display grouping, whichever side it came from. */
      phase: r.phase,
      /** Only workflow steps have one. */
      moduleName: r.moduleName,
      orderIndex: r.orderIndex,
      priority: r.priority,
      dueDate: r.dueDate,
      isRequired: r.isRequired,
      isLocked: r.isLocked,
      notes: r.notes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      assignedAt: r.assignedAt,
      completedAt: r.completedAt,
      timeTakenMs: r.timeTakenMs,
      assignedTo: r.assignedToId
        ? { id: r.assignedToId, name: r.assignedToName, role: r.assignedToRole }
        : null,
      assignedByName: r.assignedByName,
      submittedBy: r.submittedById
        ? { id: r.submittedById, name: r.submittedByName }
        : null,
      lead: r.leadId
        ? { id: r.leadId, name: r.leadName, email: r.leadEmail, stage: r.leadStage }
        : null,
      case: r.caseId
        ? { id: r.caseId, caseNumber: r.caseNumber, clientName: r.clientName }
        : null,
      /**
       * The feedback that put this row where it is, so a Rejected tab reads as
       * a list of things to fix rather than a list of titles. The full thread is
       * one call away at `/tasks/:id/review-thread`; this is the one line worth
       * showing before anyone opens it.
       */
      latestRejection: rejections.get(r.id) ?? null,
    })),
    counts,
    pagination: { total, limit, offset, page },
  };
}

/**
 * The most recent `task.rejected` note per task, in one query.
 *
 * Per-row would be a query per card. `DISTINCT ON` picks the newest per task in
 * a single pass, which Postgres does with the same index scan it needs anyway.
 */
async function latestRejections(taskIds: string[], organizationId: string) {
  const byTask = new Map<
    string,
    { note: string | null; actorName: string | null; createdAt: string }
  >();
  if (taskIds.length === 0) return byTask;

  const rows = await db
    .selectDistinctOn([auditEvents.entityId], {
      entityId: auditEvents.entityId,
      metadata: auditEvents.metadata,
      actorName: auditEvents.actorName,
      occurredAt: auditEvents.occurredAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.action, "task.rejected"),
        inArray(auditEvents.entityId, taskIds),
      ),
    )
    .orderBy(auditEvents.entityId, desc(auditEvents.occurredAt));

  for (const row of rows) {
    if (!row.entityId) continue;
    byTask.set(row.entityId, {
      note:
        ((row.metadata as Record<string, unknown> | null)?.note as string) ?? null,
      actorName: row.actorName,
      createdAt: row.occurredAt.toISOString(),
    });
  }

  return byTask;
}
