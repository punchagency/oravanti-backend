import type { Worker } from "bullmq";
import { sweepDeterministicIssues } from "../modules/case-review/deterministic-sweep";
import {
  createAiScanQueueEvents,
  createAiScanResultWorker,
  startAiScanReconciliation,
} from "./workers/ai-scan-result.worker";
import { createReminderWorker } from "./workers/reminder.worker";
import { LogEvent, createModuleLogger } from "../lib/logging/log";

const log = createModuleLogger("queue");

/**
 * Start all BullMQ workers. Called from the dedicated worker entrypoint
 * (`worker-entry.ts`) so workers run as their own process, separate from the API.
 */
export const startWorkers = (): Worker[] => {
  const workers = [createReminderWorker(), createAiScanResultWorker()];

  // Marks AI scan jobs `running` (from the queue's `active` event) and sweeps
  // up jobs that never reported back. Not Workers, but started alongside them.
  createAiScanQueueEvents();
  startAiScanReconciliation();
  startDeterministicSweep();

  log.info(
    LogEvent.QUEUE_WORKERS_STARTED,
    { workers: workers.length },
    `started ${workers.length} workers`,
  );
  return workers;
};

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day

/**
 * Re-evaluate deterministic (deadline / missing-document) issues on a schedule,
 * so they appear and escalate as time passes rather than only on the next scan.
 */
const startDeterministicSweep = (): NodeJS.Timeout => {
  const timer = setInterval(() => {
    void sweepDeterministicIssues()
      .then(({ scenarios, errors }) => {
        if (scenarios) {
          // Warn rather than info when the sweep hit errors: a sweep that
          // half-completed leaves deadline issues unraised, and at info it
          // would sit unnoticed among the successful runs.
          log.at(errors ? "warn" : "info", LogEvent.CASE_REVIEW_SWEEP_COMPLETED, {
            scenarios,
            errors,
          });
        }
      })
      .catch((err) => log.failure(LogEvent.CASE_REVIEW_SWEEP_FAILED, err));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
