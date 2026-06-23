import { Redis } from "ioredis";
import { env } from "../config/env";

/**
 * Shared ioredis connection for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it uses for
 * blocking commands (workers). We expose a single lazily-connected client that
 * both queues (producers) and workers (consumers) reuse.
 */
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
