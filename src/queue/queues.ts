import { Queue } from "bullmq";
import type { AiScanRequestJob } from "../modules/ai-scan/contract";
import { redisConnection } from "./connection";

// ─── Queue names ──────────────────────────────────────────────────────────────

export const QUESTIONNAIRE_REMINDERS_QUEUE = "questionnaire-reminders";
/** Backend → Python worker: scenario scan requests. */
export const AI_SCAN_QUEUE = "ai-scan";
/** Python worker → backend: scan results (consumed in a later Phase 3 task). */
export const AI_SCAN_RESULTS_QUEUE = "ai-scan-results";
/** Confido webhook deliveries, handled off the HTTP request. */
export const CONFIDO_WEBHOOKS_QUEUE = "confido-webhooks";

// ─── Job payloads ─────────────────────────────────────────────────────────────

export type QuestionnaireReminderJob = {
  /** questionnaire_sends.id whose response is awaited */
  sendId: string;
};

export type ConfidoWebhookJob = {
  /** Confido's event id, already claimed in payment_webhook_events. */
  eventId: string;
  eventType: string;
  /** Confido's Firm id — the only tenant identifier the payload carries. */
  firmId: string;
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

export const confidoWebhooksQueue = new Queue<ConfidoWebhookJob, void, string>(
  CONFIDO_WEBHOOKS_QUEUE,
  { connection: redisConnection, defaultJobOptions },
);

/**
 * Hand a verified Confido webhook to the worker.
 *
 * Confido marks a delivery failed if we do not answer within five seconds, and
 * disables the URL entirely after repeated failures over 24 hours — recoverable
 * only from their portal. So the HTTP route verifies, claims the event and
 * enqueues; everything that touches the network happens here.
 *
 * The job id is the event id: BullMQ-level dedupe on top of the database claim.
 * Safe to make deterministic because, unlike a scan, there is never a legitimate
 * second job for the same event.
 */
export const enqueueConfidoWebhook = async (
  job: ConfidoWebhookJob,
): Promise<void> => {
  await confidoWebhooksQueue.add("event", job, {
    jobId: `confido-${job.eventId}`,
  });
};
