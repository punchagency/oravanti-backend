import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import { labelFor, type AuditActionName } from "../../lib/audit/actions";
import { createModuleLogger } from "../../lib/logging/log";
import { recordAuditEvent } from "./audit.service";

const log = createModuleLogger("shared.task-review-events");

/**
 * The review thread for intake tasks and case workflow steps.
 *
 * Both loops — submit → review → approve/reject → reopen — used to write every
 * note into the task's single `notes` column, so each stage destroyed the one
 * before it. Everything said is appended to `audit_events` instead, and the two
 * domains read it back through the same shape.
 *
 * The thread is not a second vocabulary. A review entry is an ordinary
 * `task.*` audit row: the action a caller passes is the action stored, and the
 * action returned. There is no map in either direction, which is why a fifth
 * review verb only has to be added to `AUDIT_ACTIONS` to work end to end.
 */

/** Which side of the app the task belongs to. Doubles as the row's `entity_type`. */
export type TaskReviewKind = "lead_task" | "case_step";

/**
 * Any `task.*` action in the registry.
 *
 * Deliberately the whole family rather than the four review verbs: the thread
 * reads back every `task.*` row on the task, so anything writable is also
 * readable here, and the two halves cannot drift apart.
 */
export type TaskReviewAction = Extract<AuditActionName, `task.${string}`>;

export interface RecordReviewEventInput {
  organizationId: string;
  taskKind: TaskReviewKind;
  taskId: string;
  action: TaskReviewAction;
  note?: string | null;
  /** `staff.id` of whoever acted, when the caller knows it better than the request context. */
  actorId?: string | null;
  leadId?: string | null;
  caseId?: string | null;
}

export interface TaskReviewEventDTO {
  id: string;
  /** A registry action name, e.g. `"task.rejected"`. */
  action: TaskReviewAction;
  /** The registry's label for that action, e.g. `"Task rejected"`. */
  label: string;
  /** What the reviewer typed, or null when they said nothing. */
  note: string | null;
  /** The sentence written when the row was recorded. */
  summary: string;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

/**
 * Appends one entry to a task's review thread.
 *
 * Never throws into the caller's path: a lost review line must not roll back
 * the status change the user actually asked for. Failures are logged instead.
 */
export async function recordTaskReviewEvent(
  input: RecordReviewEventInput,
): Promise<void> {
  const note = input.note?.trim() || null;

  try {
    await recordAuditEvent({
      action: input.action,
      entityId: input.taskId,
      // The registry says `task`; the thread needs to tell an intake task from
      // a workflow step, and reads filter on it.
      entityType: input.taskKind,
      parentEntityType: input.leadId ? "lead" : input.caseId ? "case" : undefined,
      parentEntityId: input.leadId ?? input.caseId ?? undefined,
      summary: note
        ? `${labelFor(input.action)}: ${note}`
        : labelFor(input.action),
      metadata: { taskKind: input.taskKind, note },
      organizationId: input.organizationId,
      actor: input.actorId ? { staffId: input.actorId } : undefined,
      onWriteFailure: "log",
    });
  } catch (err) {
    log.failure("task_review.event_write_failed", err, { taskId: input.taskId });
  }
}

type ReviewRow = {
  id: string;
  entityId: string | null;
  action: string;
  summary: string;
  metadata: unknown;
  actorStaffId: string | null;
  actorName: string | null;
  occurredAt: Date;
};

const reviewColumns = {
  id: auditEvents.id,
  entityId: auditEvents.entityId,
  action: auditEvents.action,
  summary: auditEvents.summary,
  metadata: auditEvents.metadata,
  actorStaffId: auditEvents.actorStaffId,
  actorName: auditEvents.actorName,
  occurredAt: auditEvents.occurredAt,
};

const toReviewEvent = (row: ReviewRow): TaskReviewEventDTO => ({
  id: row.id,
  action: row.action as TaskReviewAction,
  label: labelFor(row.action),
  note: ((row.metadata as Record<string, unknown> | null)?.note as string) ?? null,
  summary: row.summary,
  actorId: row.actorStaffId,
  // The stored snapshot, never a live join onto `staff` — renaming a staff
  // member must not rewrite who said what.
  actorName: row.actorName,
  createdAt: row.occurredAt.toISOString(),
});

/** A task's full review thread, oldest first. */
export async function getTaskReviewEvents(
  taskKind: TaskReviewKind,
  taskId: string,
  organizationId: string,
): Promise<TaskReviewEventDTO[]> {
  const rows = await db
    .select(reviewColumns)
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.entityType, taskKind),
        eq(auditEvents.entityId, taskId),
        sql`${auditEvents.action} LIKE 'task.%'`,
      ),
    )
    .orderBy(asc(auditEvents.occurredAt));

  return rows.map(toReviewEvent);
}

/**
 * Review threads for many tasks at once, keyed by task id.
 *
 * List screens show the latest rejection feedback inline; fetching per row
 * would be a query per task.
 */
export async function getTaskReviewEventsForTasks(
  taskKind: TaskReviewKind,
  taskIds: string[],
  organizationId: string,
): Promise<Map<string, TaskReviewEventDTO[]>> {
  const byTask = new Map<string, TaskReviewEventDTO[]>();
  if (taskIds.length === 0) return byTask;

  const rows = await db
    .select(reviewColumns)
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, organizationId),
        eq(auditEvents.entityType, taskKind),
        inArray(auditEvents.entityId, taskIds),
        sql`${auditEvents.action} LIKE 'task.%'`,
      ),
    )
    .orderBy(asc(auditEvents.occurredAt));

  for (const row of rows) {
    // `entity_id` is nullable on the table — it cannot be null for a row the
    // `IN` clause matched, but the column type does not know that.
    if (!row.entityId) continue;
    const list = byTask.get(row.entityId) ?? [];
    list.push(toReviewEvent(row));
    byTask.set(row.entityId, list);
  }

  return byTask;
}
