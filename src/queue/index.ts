import type { Worker } from "bullmq";
import { createDocumentScanWorker } from "./workers/document-scan.worker";
import { createReminderWorker } from "./workers/reminder.worker";

/**
 * Start all BullMQ workers. Called from the dedicated worker entrypoint
 * (`worker-entry.ts`) so workers run as their own process, separate from the API.
 */
export const startWorkers = (): Worker[] => {
  const workers = [createReminderWorker(), createDocumentScanWorker()];
  console.log(`[queue] started ${workers.length} workers`);
  return workers;
};
