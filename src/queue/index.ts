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
import { runAuditRetention } from "../modules/shared/audit-retention.service";
import { LogEvent } from "../lib/logging/events";
import { createModuleLogger } from "../lib/logging/log";

const log = createModuleLogger("queue");

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
  startAuditRetention();
  startWebhookStalenessSweep();

  log.info(
    "queue.workers_started",
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
          log.at(errors ? "warn" : "info", "case_review.sweep_completed", {
            scenarios,
            errors,
          });
        }
      })
      .catch((err) => log.failure("case_review.sweep_failed", err));
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
};

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

/**
 * Purge audit rows past their retention window.
 *
 * Daily rather than hourly: the windows are measured in years, so nothing is
 * urgent, and a bounded pass that runs once a day drains any backlog within a
 * few days without ever holding long locks. `runAuditRetention` handles its own
 * failures and no-ops when the maintenance role is unconfigured, so nothing
 * here needs a catch beyond the safety net.
 */
const startAuditRetention = (): NodeJS.Timeout => {
  const timer = setInterval(() => {
    void runAuditRetention().catch((err) =>
      log.failure("audit.retention_failed", err),
    );
  }, RETENTION_INTERVAL_MS);
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
      log.failure(LogEvent.PAYMENT_WEBHOOK_STALENESS_SWEEP_FAILED, err),
    );
  }, WEBHOOK_STALENESS_INTERVAL_MS);
  timer.unref?.();
  return timer;
};
