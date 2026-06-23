import { Queue } from "bullmq";
import { redisConnection } from "./connection";

// ─── Queue names ──────────────────────────────────────────────────────────────

export const QUESTIONNAIRE_REMINDERS_QUEUE = "questionnaire-reminders";
export const DOCUMENT_SCAN_QUEUE = "document-scan";

// ─── Job payloads ─────────────────────────────────────────────────────────────

export type QuestionnaireReminderJob = {
  /** questionnaire_sends.id whose response is awaited */
  sendId: string;
};

export type DocumentScanJob = {
  /** questionnaire_response_files.id to scan */
  fileId: string;
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

export const documentScanQueue = new Queue<DocumentScanJob, void, string>(
  DOCUMENT_SCAN_QUEUE,
  { connection: redisConnection, defaultJobOptions },
);

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
    { delay: days * 24 * 60 * 60 * 1000, jobId: `reminder:${sendId}` },
  );
  return job.id;
};

/** Cancel a previously-scheduled reminder (no-op if it already ran / is gone). */
export const cancelQuestionnaireReminder = async (jobId: string) => {
  const job = await questionnaireRemindersQueue.getJob(jobId);
  if (job) await job.remove();
};

/** Enqueue an immediate document scan for an uploaded file. */
export const enqueueDocumentScan = async (fileId: string) => {
  await documentScanQueue.add("scan", { fileId });
};
