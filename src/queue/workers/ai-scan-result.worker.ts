import { QueueEvents, Worker } from "bullmq";
import type { AiScanResultJob } from "../../modules/ai-scan/contract";
import {
  markScanRunning,
  persistScanResult,
  reconcileStuckScans,
} from "../../modules/ai-scan/scan-result.service";
import { redisConnection } from "../connection";
import { AI_SCAN_QUEUE, AI_SCAN_RESULTS_QUEUE } from "../queues";

/**
 * Consume scan results the Python worker publishes to `ai-scan-results` and
 * persist them (facts, photo comparisons, job close-out).
 *
 * Idempotency lives in `persistScanResult` (keyed by job_id) so a redelivered
 * result is a no-op — BullMQ is at-least-once.
 */
export const createAiScanResultWorker = () =>
  new Worker<AiScanResultJob>(
    AI_SCAN_RESULTS_QUEUE,
    async (job) => {
      await persistScanResult(job.data);
    },
    // Own connection: BullMQ blocking consumers monopolize their connection, so
    // each Worker / QueueEvents gets a dedicated duplicate rather than sharing.
    { connection: redisConnection.duplicate() },
  );

/**
 * Listen to the scan queue's lifecycle events to mark jobs `running`.
 *
 * The Python worker never touches Postgres, so the backend learns a job started
 * from BullMQ's cross-language `active` event. The event's jobId is the
 * ai_scan_jobs row id (we set them equal at enqueue time).
 */
export const createAiScanQueueEvents = () => {
  const events = new QueueEvents(AI_SCAN_QUEUE, {
    connection: redisConnection.duplicate(),
  });
  events.on("active", ({ jobId }) => {
    void markScanRunning(jobId).catch((err) =>
      console.error(`[ai-scan] markScanRunning failed for ${jobId}:`, err),
    );
  });
  return events;
};

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

/**
 * Periodically fail jobs stuck in queued/running past their timeout — a crashed
 * worker or lost result would otherwise leave a scenario permanently blocked
 * from re-scanning (its in-flight row never clears).
 */
export const startAiScanReconciliation = (): NodeJS.Timeout => {
  const timer = setInterval(() => {
    void reconcileStuckScans()
      .then(({ staleRunning, staleQueued }) => {
        if (staleRunning || staleQueued) {
          console.warn(
            `[ai-scan] reconciled stuck jobs: running=${staleRunning} queued=${staleQueued}`,
          );
        }
      })
      .catch((err) => console.error("[ai-scan] reconciliation failed:", err));
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
