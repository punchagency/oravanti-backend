// MUST be first. Instrumentation patches express, pg and ioredis as they are
// required, so anything imported above this line is loaded unpatched. See the
// module's own note for why this is a bare import and not a function call.
import "./telemetry/bootstrap";

import { shutdownTelemetry } from "./telemetry";
import { env } from "./config/env";
import { App } from "./app";
import { closeDb } from "./db/client";
import { modules } from "./modules";

const PORT = Number(env.PORT);

const app = new App(modules, PORT);

/**
 * Deploys send SIGTERM. Without a handler the process dies immediately, cutting
 * in-flight requests mid-transaction and dropping connections rather than
 * draining them. The worker entrypoint has done this correctly all along; the
 * API — the process that actually receives deploy signals — did not.
 */
const SHUTDOWN_DEADLINE_MS = 15_000;

async function main() {
  const server = await app.listen();

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    // A second signal during shutdown should not restart the sequence.
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[shutdown] ${signal} received, draining…`);

    // Stop accepting new connections, then wait for in-flight ones to finish.
    server.close(async () => {
      try {
        await closeDb();
        // Both exporters batch. Without this the spans and log records
        // describing the shutdown — including whatever triggered it — are
        // still buffered when the process exits.
        await shutdownTelemetry();
        console.log("[shutdown] clean");
        process.exit(0);
      } catch (error) {
        console.error("[shutdown] error closing database:", error);
        process.exit(1);
      }
    });

    // A hung request must not hold the deploy open forever.
    setTimeout(() => {
      console.error("[shutdown] deadline exceeded, forcing exit");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection leaves the process in an unknown state. Log it with
  // the reason intact, then drain rather than carry on serving from it.
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] unhandled rejection:", reason);
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    console.error("[fatal] uncaught exception:", error);
    void shutdown("uncaughtException");
  });
}

main().catch((error) => {
  console.error("Failed to start app:", error);
  process.exit(1);
});
