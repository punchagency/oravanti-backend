import { Redis } from "ioredis";
import { env } from "../config/env";
import { createModuleLogger } from "../lib/logging/log";

const log = createModuleLogger("queue.connection");

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
  // The whole error, not `err.message`. ioredis attaches the syscall, errno
  // and address, which is the difference between "connection error" and
  // knowing it is ECONNREFUSED against the wrong host.
  log.failure("queue.redis_error", err);
});
