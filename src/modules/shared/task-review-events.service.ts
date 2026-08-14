import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { staff } from "../../db/schema/staff";
import {
  taskReviewEvents,
  type TaskReviewAction,
  type TaskReviewKind,
} from "../../db/schema/task-review-events";

/**
 * The review thread for intake tasks and case workflow steps.
 *
 * Both loops — submit → review → approve/reject → reopen — used to write every
 * note into the task's single `notes` column, so each stage destroyed the one
 * before it. Everything said is appended here instead, and the two domains read
 * it back through the same shape.
 */

export interface RecordReviewEventInput {
  organizationId: string;
  taskKind: TaskReviewKind;
  taskId: string;
  action: TaskReviewAction;
  note?: string | null;
  actorId?: string | null;
  leadId?: string | null;
  caseId?: string | null;
}

export interface TaskReviewEventDTO {
  id: string;
  action: TaskReviewAction;
  note: string | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: string;
}

async function resolveActorName(actorId?: string | null) {
  if (!actorId) return null;
  const [row] = await db
    .select({ firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(eq(staff.id, actorId))
    .limit(1);
  if (!row) return null;
  return `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || null;
}

/**
 * Appends one entry to a task's review thread.
 *
 * Never throws into the caller's path: a lost audit line must not roll back the
 * status change the user actually asked for. Failures are logged instead.
 */
export async function recordTaskReviewEvent(
  input: RecordReviewEventInput,
): Promise<void> {
  try {
    const actorName = await resolveActorName(input.actorId);
    await db.insert(taskReviewEvents).values({
      organizationId: input.organizationId,
      taskKind: input.taskKind,
      taskId: input.taskId,
      leadId: input.leadId ?? null,
      caseId: input.caseId ?? null,
      action: input.action,
      note: input.note?.trim() || null,
      actorId: input.actorId ?? null,
      actorName,
    });
  } catch (err) {
    console.error("Failed to record task review event", {
      taskKind: input.taskKind,
      taskId: input.taskId,
      action: input.action,
      err,
    });
  }
}

/** A task's full review thread, oldest first. */
export async function getTaskReviewEvents(
  taskKind: TaskReviewKind,
  taskId: string,
  organizationId: string,
): Promise<TaskReviewEventDTO[]> {
  const rows = await db
    .select({
      id: taskReviewEvents.id,
      action: taskReviewEvents.action,
      note: taskReviewEvents.note,
      actorId: taskReviewEvents.actorId,
      actorName: taskReviewEvents.actorName,
      createdAt: taskReviewEvents.createdAt,
    })
    .from(taskReviewEvents)
    .where(
      and(
        eq(taskReviewEvents.taskKind, taskKind),
        eq(taskReviewEvents.taskId, taskId),
        eq(taskReviewEvents.organizationId, organizationId),
      ),
    )
    .orderBy(asc(taskReviewEvents.createdAt));

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
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
    .select({
      id: taskReviewEvents.id,
      taskId: taskReviewEvents.taskId,
      action: taskReviewEvents.action,
      note: taskReviewEvents.note,
      actorId: taskReviewEvents.actorId,
      actorName: taskReviewEvents.actorName,
      createdAt: taskReviewEvents.createdAt,
    })
    .from(taskReviewEvents)
    .where(
      and(
        eq(taskReviewEvents.taskKind, taskKind),
        eq(taskReviewEvents.organizationId, organizationId),
      ),
    )
    .orderBy(asc(taskReviewEvents.createdAt));

  const wanted = new Set(taskIds);
  for (const row of rows) {
    if (!wanted.has(row.taskId)) continue;
    const { taskId, createdAt, ...rest } = row;
    const list = byTask.get(taskId) ?? [];
    list.push({ ...rest, createdAt: createdAt.toISOString() });
    byTask.set(taskId, list);
  }

  return byTask;
}
