// MUST be first, for the same reason it is first in src/index.ts — and it
// matters more here: a queue worker's whole job is the async follow-on work of
// a request, so an unpatched worker is exactly the half of a trace that goes
// missing.
import "../telemetry/bootstrap";

import "dotenv/config";
import { shutdownTelemetry } from "../telemetry";
import { closeDb } from "../db/client";
import { createModuleLogger, LogEvent } from "../lib/logging/log";
import { redisConnection } from "./connection";
import { startWorkers } from "./index";

const log = createModuleLogger("worker-entry");

const workers = startWorkers();

const shutdown = async () => {
  log.info(LogEvent.QUEUE_SHUTDOWN_REQUESTED);
  await Promise.all(workers.map((w) => w.close()));
  await redisConnection.quit();
  await closeDb();
  await shutdownTelemetry();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
