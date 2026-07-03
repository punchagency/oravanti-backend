import "dotenv/config";
import { closeDb } from "../db/client";
import { redisConnection } from "./connection";
import { startWorkers } from "./index";

const workers = startWorkers();

const shutdown = async () => {
  console.log("[queue] shutting down workers…");
  await Promise.all(workers.map((w) => w.close()));
  await redisConnection.quit();
  await closeDb();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
