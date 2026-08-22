import { QueueEvents, Worker } from "bullmq";
import type { AiScanResultJob } from "../../modules/ai-scan/contract";
import {
  markScanRunning,
  persistScanResult,
  reconcileStuckScans,
} from "../../modules/ai-scan/scan-result.service";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { runWithRequestContext } from "../../middleware/request-context";
import { redisConnection } from "../connection";
import { AI_SCAN_QUEUE, AI_SCAN_RESULTS_QUEUE } from "../queues";

const log = createModuleLogger("ai-scan-result.worker");

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
    async (job) =>
      /*
        A context, but a fresh id — unlike the reminder worker, which reuses
        the enqueuing request's.

        These jobs are produced by the Python scan worker, which never saw the
        HTTP request and carries nothing to correlate with. What matters here
        is that the work runs *inside* a context at all: persistScanResult
        writes audit rows, and outside one they would be attributed to the
        process rather than to this job. `job_id` in the payload is the
        ai_scan_jobs row id, which is the join back to the request that
        requested the scan.
      */
      runWithRequestContext({ source: "queue" }, async () => {
        await persistScanResult(job.data);
      }),
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
      log.failure(LogEvent.AI_SCAN_MARK_RUNNING_FAILED, err, { jobId }),
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
          log.warn(LogEvent.AI_SCAN_RESULT_ORPHANED, { staleRunning, staleQueued });
        }
      })
      .catch((err) => log.failure(LogEvent.AI_SCAN_RECONCILIATION_FAILED, err));
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
