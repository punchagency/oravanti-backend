import { aiScanQueue } from "../../src/queue/queues";

/**
 * The round-trip checks (`06-roundtrip`, `09-live-roundtrip`) spawn their own
 * `ai-scan` consumer and rely on exclusive ownership of that queue: BullMQ hands
 * each job to exactly one consumer, so a second one steals it and the check's
 * bridge times out on a job it never receives.
 *
 * The common cause is a real `oravanti-ai-worker` running alongside the check.
 * It connects to Redis via `redis-py`; everything on the Node side uses
 * `ioredis`, so a `redis-py`-named client at check start-up (before we spawn our
 * own Python bridge) means an external consumer is already draining `ai-scan`.
 * `Queue.getWorkers()` does not see the Python worker cross-language, which is
 * why we read the raw client list instead.
 */
export const externalAiScanConsumerPresent = async (): Promise<boolean> => {
  try {
    const client = await aiScanQueue.client;
    const list = (await client.call("CLIENT", "LIST")) as string;
    return list.split("\n").some((line) => line.includes("name=redis-py"));
  } catch {
    // If we can't inspect Redis, don't block the check — let it run and fail
    // loudly rather than skip on a false signal.
    return false;
  }
};

/**
 * Skip the current check (exit 0) when another process is consuming `ai-scan`.
 * Prints a clear reason so the timeout cascade doesn't look like a real failure.
 */
export const skipIfExternalAiScanConsumer = async (
  checkName: string,
): Promise<void> => {
  if (await externalAiScanConsumerPresent()) {
    console.log(
      `\x1b[33mSKIP\x1b[0m ${checkName}: another process is consuming the 'ai-scan' queue ` +
        `(a real oravanti-ai-worker is running). Stop it, then re-run — this check needs ` +
        `exclusive ownership of the queue.`,
    );
    await aiScanQueue.close().catch(() => {});
    process.exit(0);
  }
};
