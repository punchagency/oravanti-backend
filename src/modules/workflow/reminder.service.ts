import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { tasks } from "../../db/schema/tasks";
import { env } from "../../config/env";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { notify } from "../../notifications/notification.service";

const log = createModuleLogger("workflow.reminders");

/** `YYYY-MM-DD`, matching the `date` columns these compare against. */
const toDateString = (d: Date) => d.toISOString().split("T")[0];

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const daysBetween = (from: Date, to: Date) =>
  Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));

/**
 * The fractions of an RFE response window at which to remind.
 *
 * Deliberately a local constant, not configuration: this is the one documented
 * need for percentage-of-interval reminders in the whole system, and a general
 * engine for it would be built for a single caller.
 */
const RFE_REMINDER_FRACTIONS = [0.5, 0.75, 0.9] as const;

/**
 * The reminder titles and dates for one RFE window — the whole date
 * calculation, with no database in it, so the offsets can be tested directly
 * against the 30/60/87-day windows the source material names.
 *
 * Returns `[]` for a non-positive window (a deadline on or before the issue
 * date is a data-entry error, not a zero-reminder schedule worth creating).
 */
export function rfeReminderSchedule(
  rfeIssuedDate: Date,
  rfeDeadline: Date,
): { title: string; dueDate: string }[] {
  const windowDays = daysBetween(rfeIssuedDate, rfeDeadline);
  if (windowDays <= 0) return [];

  return RFE_REMINDER_FRACTIONS.map((fraction) => ({
    title: `RFE response reminder (${Math.round(fraction * 100)}% of window elapsed)`,
    dueDate: toDateString(addDays(rfeIssuedDate, Math.round(windowDays * fraction))),
  }));
}

/**
 * Creates the three RFE response reminders for a case.
 *
 * The only reminder in the system that can't be a static template step: the
 * response window is 30, 60 or 87 days depending on what the notice itself
 * says, so it is only knowable once an actual RFE is logged — which is why
 * these are `ad_hoc` tasks created here rather than `workflow` tasks
 * materialized from a template.
 *
 * Idempotent per (case, deadline): re-logging the same RFE deadline will not
 * duplicate the reminders, so a correction to `rfeIssuedDate` re-creates the
 * set against the new window instead of stacking a second one.
 */
export async function scheduleRfeReminders(
  caseId: string,
  rfeIssuedDate: Date,
  rfeDeadline: Date,
): Promise<void> {
  const [caseRow] = await db
    .select({ organizationId: cases.organizationId })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!caseRow) return;

  const windowDays = daysBetween(rfeIssuedDate, rfeDeadline);
  const reminders = rfeReminderSchedule(rfeIssuedDate, rfeDeadline);
  if (reminders.length === 0) {
    log.warn("workflow.rfe_reminders_scheduled", { caseId, windowDays, skipped: true });
    return;
  }

  const existingTitles = new Set(
    (
      await db
        .select({ title: tasks.title })
        .from(tasks)
        .where(
          and(
            eq(tasks.caseId, caseId),
            eq(tasks.source, "ad_hoc"),
            inArray(tasks.title, reminders.map((r) => r.title)),
          ),
        )
    ).map((r) => r.title),
  );

  const toCreate = reminders.filter((r) => !existingTitles.has(r.title));
  if (toCreate.length === 0) return;

  await db.insert(tasks).values(
    toCreate.map((r) => ({
      organizationId: caseRow.organizationId,
      caseId,
      source: "ad_hoc" as const,
      title: r.title,
      description: `RFE issued ${toDateString(rfeIssuedDate)}, response due ${toDateString(rfeDeadline)} (${windowDays}-day window read from the notice).`,
      dueDate: r.dueDate,
      isRequired: false,
    })),
  );

  log.action("workflow.rfe_reminders_scheduled", { caseId, windowDays, created: toCreate.length });
}

/** Statuses a reminder should never fire for — the work is already done or abandoned. */
const CLOSED_STATUSES = ["completed", "cancelled", "skipped"] as const;

/** The de-dup columns a reminder threshold stamps once it has fired. */
export type ReminderSentColumns = {
  dueDate: string | null;
  reminder3dSentAt: Date | null;
  reminder1dSentAt: Date | null;
  overdueReminderSentAt: Date | null;
};

/**
 * Which threshold a task has crossed, or null when the one it's crossed has
 * already been sent. Ordered most-urgent-first so an overdue task reports
 * overdue rather than "due in 1 day".
 *
 * Exported for its own tests: this predicate is what makes the sweep
 * idempotent, so it is worth pinning down independently of the query around it.
 */
export function pendingThreshold(task: ReminderSentColumns, today: Date) {
  if (!task.dueDate) return null;
  const daysUntilDue = daysBetween(today, new Date(task.dueDate));

  if (daysUntilDue <= 0) return task.overdueReminderSentAt ? null : { column: "overdueReminderSentAt", category: "task_overdue" } as const;
  if (daysUntilDue <= 1) return task.reminder1dSentAt ? null : { column: "reminder1dSentAt", category: "task_due_soon" } as const;
  if (daysUntilDue <= 3) return task.reminder3dSentAt ? null : { column: "reminder3dSentAt", category: "task_due_soon" } as const;
  return null;
}

/**
 * Hourly sweep: notify assignees of tasks due within three days or overdue.
 *
 * The three `*SentAt` columns on `tasks` are the de-dup mechanism — each
 * threshold fires exactly once per task no matter how often this runs, checked
 * on the row itself rather than by joining back against `notifications`.
 *
 * Unassigned tasks are skipped rather than escalated: there is nobody to
 * notify, and inventing a fallback recipient (the case's lead attorney, say)
 * would mean this sweep quietly reassigns responsibility. Surfacing unassigned
 * overdue work belongs to the case-review rules engine, which already owns
 * case-health signals.
 */
export async function taskDeadlineSweep(): Promise<{ scanned: number; notified: number }> {
  const today = new Date();
  const horizon = toDateString(addDays(today, 3));

  const due = await db
    .select({
      id: tasks.id,
      organizationId: tasks.organizationId,
      title: tasks.title,
      dueDate: tasks.dueDate,
      caseId: tasks.caseId,
      assignedToId: tasks.assignedToId,
      reminder3dSentAt: tasks.reminder3dSentAt,
      reminder1dSentAt: tasks.reminder1dSentAt,
      overdueReminderSentAt: tasks.overdueReminderSentAt,
    })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.dueDate),
        lte(tasks.dueDate, horizon),
        isNotNull(tasks.assignedToId),
        sql`${tasks.status} NOT IN ${CLOSED_STATUSES}`,
      ),
    );

  let notified = 0;

  for (const task of due) {
    const threshold = pendingThreshold(task, today);
    if (!threshold || !task.assignedToId) continue;

    /*
      Awaited rather than fire-and-forget, unlike most `notify` call sites.

      The stamp on the next line is what stops this task being reminded about
      again, so writing it before the send is settled would let a failed
      dispatch silently consume the only reminder that threshold ever gets.
      `notify` already records a row per recipient per channel — including a
      `skipped` one when a firm preference blocks it — so a throw here means
      something genuinely went wrong, not that the message was suppressed.
    */
    try {
      await notify({
        organizationId: task.organizationId,
        event: threshold.category,
        recipients: [{ type: "staff", id: task.assignedToId }],
        context: {
          title: task.title,
          dueDate: task.dueDate ?? undefined,
          link: task.caseId
            ? `${env.FRONTEND_APP_URL}/admin/cases/${task.caseId}`
            : `${env.FRONTEND_APP_URL}/admin/my-tasks`,
        },
        scenario: { caseId: task.caseId ?? undefined },
        // One per task per threshold, so a sweep that runs twice in a day —
        // or a redeploy mid-sweep — cannot send the same reminder twice.
        dedupeKey: `task-${threshold.category}-${task.id}`,
      });
    } catch (err) {
      log.failure(LogEvent.NOTIFICATION_DISPATCH_FAILED, err, {
        taskId: task.id,
        event: threshold.category,
      });
      continue;
    }

    await db.update(tasks).set({ [threshold.column]: new Date() }).where(eq(tasks.id, task.id));
    notified++;
  }

  log.action("task.deadline_sweep_completed", { scanned: due.length, notified });
  return { scanned: due.length, notified };
}
