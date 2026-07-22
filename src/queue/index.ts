import type { Worker } from "bullmq";
import {
  createAiScanQueueEvents,
  createAiScanResultWorker,
  startAiScanReconciliation,
} from "./workers/ai-scan-result.worker";
import { createReminderWorker } from "./workers/reminder.worker";

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

  console.log(`[queue] started ${workers.length} workers`);
  return workers;
};
