import { Queue } from "bullmq";
import type { AiScanRequestJob } from "../modules/ai-scan/contract";
import { redisConnection } from "./connection";

// ─── Queue names ──────────────────────────────────────────────────────────────

export const QUESTIONNAIRE_REMINDERS_QUEUE = "questionnaire-reminders";
/** Every outbound message — email, SMS and in-app alike. */
export const NOTIFICATIONS_QUEUE = "notifications";
/** Backend → Python worker: scenario scan requests. */
export const AI_SCAN_QUEUE = "ai-scan";
/** Python worker → backend: scan results (consumed in a later Phase 3 task). */
export const AI_SCAN_RESULTS_QUEUE = "ai-scan-results";

// ─── Job payloads ─────────────────────────────────────────────────────────────

export type QuestionnaireReminderJob = {
  /** questionnaire_sends.id whose response is awaited */
  sendId: string;
};

/**
 * Carries only the row id: the `notifications` row is the source of truth for
 * what to send, to whom, and whether it still should be. A payload carrying the
 * message would go stale between scheduling and sending — which for a
 * consultation reminder is a full day.
 */
export type NotificationJob = {
  notificationId: string;
  organizationId: string;
};

// ─── Producers ────────────────────────────────────────────────────────────────

const defaultJobOptions = {
  removeOnComplete: { age: 60 * 60 * 24 }, // keep 1 day for inspection
  removeOnFail: { age: 60 * 60 * 24 * 7 },
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
};

export const questionnaireRemindersQueue = new Queue<
  QuestionnaireReminderJob,
  void,
  string
>(QUESTIONNAIRE_REMINDERS_QUEUE, {
  connection: redisConnection,
  defaultJobOptions,
});

/**
 * Schedule a reminder to fire after `days` days. Returns the BullMQ job id so the
 * caller can persist it and cancel the reminder later (e.g. on submission).
 */
export const scheduleQuestionnaireReminder = async (
  sendId: string,
  days: number,
): Promise<string | undefined> => {
  const job = await questionnaireRemindersQueue.add(
    "reminder",
    { sendId },
    { delay: days * 24 * 60 * 60 * 1000, jobId: `reminder-${sendId}` },
  );
  return job.id;
};

/** Cancel a previously-scheduled reminder (no-op if it already ran / is gone). */
export const cancelQuestionnaireReminder = async (jobId: string) => {
  const job = await questionnaireRemindersQueue.getJob(jobId);
  if (job) await job.remove();
};

// ─── Notifications ──────────────────────────────────────────────────────────

export const notificationsQueue = new Queue<NotificationJob, void, string>(
  NOTIFICATIONS_QUEUE,
  { connection: redisConnection, defaultJobOptions },
);

/**
 * Enqueue a notification for delivery.
 *
 * The deterministic `notif-<uuid>` job id is safe here, unlike the ai-scan case
 * below: a notification row id is unique per attempt, so a completed job
 * lingering under that id can never block a later one — there is no later one
 * for the same row.
 */
export const enqueueNotification = async (
  notification: { id: string; organizationId: string },
  delayMs = 0,
): Promise<string | undefined> => {
  const job = await notificationsQueue.add(
    "notification",
    {
      notificationId: notification.id,
      organizationId: notification.organizationId,
    },
    { jobId: `notif-${notification.id}`, delay: delayMs },
  );
  return job.id;
};

/** Remove a scheduled notification job (no-op if it already ran or is gone). */
export const cancelNotificationJob = async (notificationId: string) => {
  const job = await notificationsQueue.getJob(`notif-${notificationId}`);
  if (job) await job.remove();
};

// ─── AI scan ────────────────────────────────────────────────────────────────

export const aiScanQueue = new Queue<AiScanRequestJob, void, string>(
  AI_SCAN_QUEUE,
  { connection: redisConnection, defaultJobOptions },
);

/**
 * Low-level enqueue for a built scan request. `jobId` is the ai_scan_jobs row id
 * (a UUID) so BullMQ job identity matches the DB row — clean result mapping and
 * idempotent result handling. Coalescing is done by the ai_scan_jobs in-flight
 * unique index in `enqueueScenarioScan`, NOT by a deterministic BullMQ id (a
 * deterministic id would block the next scan while a completed job lingers). A
 * short `delayMs` lets a burst of uploads collapse into one scan.
 */
export const enqueueAiScanJob = async (
  jobId: string,
  payload: AiScanRequestJob,
  delayMs = 0,
): Promise<string | undefined> => {
  const job = await aiScanQueue.add("scan", payload, { jobId, delay: delayMs });
  return job.id;
};

/** Remove a queued scan job (e.g. when its ai_scan_jobs row is cancelled). */
export const removeAiScanJob = async (jobId: string) => {
  const job = await aiScanQueue.getJob(jobId);
  if (job) await job.remove();
};
