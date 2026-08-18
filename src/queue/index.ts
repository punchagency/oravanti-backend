import type { Worker } from "bullmq";
import { sweepDeterministicIssues } from "../modules/case-review/deterministic-sweep";
import {
  createAiScanQueueEvents,
  createAiScanResultWorker,
  startAiScanReconciliation,
} from "./workers/ai-scan-result.worker";
import { createConfidoWebhookWorker } from "./workers/confido-webhook.worker";
import { reportStaleWebhookEvents } from "../modules/finance/confido/webhook-staleness";
import { createReminderWorker } from "./workers/reminder.worker";

/**
 * Start all BullMQ workers. Called from the dedicated worker entrypoint
 * (`worker-entry.ts`) so workers run as their own process, separate from the API.
 */
export const startWorkers = (): Worker[] => {
  const workers = [
    createReminderWorker(),
    createAiScanResultWorker(),
    createConfidoWebhookWorker(),
  ];

  // Marks AI scan jobs `running` (from the queue's `active` event) and sweeps
  // up jobs that never reported back. Not Workers, but started alongside them.
  createAiScanQueueEvents();
  startAiScanReconciliation();
  startDeterministicSweep();
  startWebhookStalenessSweep();

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

/**
 * How often to look for webhook events that were accepted but never handled.
 *
 * Every five minutes, against a five-minute staleness threshold, so a worker
 * that stops consuming is reported within roughly ten minutes rather than
 * whenever someone next wonders why an invoice is unpaid.
 *
 * Runs in the worker process, which is admittedly the process most likely to be
 * the thing that is broken. That is a real limitation and worth naming: it
 * catches a worker that is running but not consuming — the failure we actually
 * hit — and not a worker that is not running at all. The latter is what process
 * supervision is for.
 */
const WEBHOOK_STALENESS_INTERVAL_MS = 5 * 60 * 1000;

const startWebhookStalenessSweep = (): NodeJS.Timeout => {
  const timer = setInterval(() => {
    void reportStaleWebhookEvents().catch((err) =>
      console.error("[confido] staleness sweep failed:", err),
    );
  }, WEBHOOK_STALENESS_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
