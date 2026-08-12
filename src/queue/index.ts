import type { Worker } from "bullmq";
import { sweepDeterministicIssues } from "../modules/case-review/deterministic-sweep";
import {
  createAiScanQueueEvents,
  createAiScanResultWorker,
  startAiScanReconciliation,
} from "./workers/ai-scan-result.worker";
import {
  createNotificationWorker,
  startNotificationSweep,
} from "./workers/notification.worker";
import { createReminderWorker } from "./workers/reminder.worker";

/**
 * Start all BullMQ workers. Called from the dedicated worker entrypoint
 * (`worker-entry.ts`) so workers run as their own process, separate from the API.
 */
export const startWorkers = (): Worker[] => {
  const workers = [
    createReminderWorker(),
    createAiScanResultWorker(),
    createNotificationWorker(),
  ];

  // Marks AI scan jobs `running` (from the queue's `active` event) and sweeps
  // up jobs that never reported back. Not Workers, but started alongside them.
  createAiScanQueueEvents();
  startAiScanReconciliation();
  startDeterministicSweep();
  // Recovers scheduled notifications whose delayed job was lost with Redis.
  startNotificationSweep();

  console.log(`[queue] started ${workers.length} workers`);
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
          console.log(
            `[case-review] deterministic sweep: ${scenarios} scenario(s), ${errors} error(s)`,
          );
        }
      })
      .catch((err) => console.error("[case-review] sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
