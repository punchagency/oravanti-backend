/**
 * What is in the Confido webhook queue, and is anything consuming it.
 *
 *   npx tsx scripts/q-inspect.ts
 *
 * Written while debugging a live webhook test where money was arriving and
 * never reaching the ledger. The cause was a worker process that existed in
 * `ps` but had stopped consuming — `npm run worker:dev` was running, its child
 * was not. Nothing surfaced that: the HTTP path returned 200, events were
 * claimed in `payment_webhook_events`, and the jobs simply queued forever.
 *
 * **`attached workers: 0` with a non-zero waiting count is that failure**, and
 * it is the first thing to check when payments are not appearing.
 */
import { confidoWebhooksQueue } from "../src/queue/queues";
import { redisConnection } from "../src/queue/connection";

const main = async () => {
  const [counts, workers] = await Promise.all([
    confidoWebhooksQueue.getJobCounts(),
    confidoWebhooksQueue.getWorkers(),
  ]);

  console.log(`\n  attached workers: ${workers.length}`);
  if (workers.length === 0 && counts.waiting > 0) {
    console.log(
      "  \x1b[31mNothing is consuming this queue.\x1b[0m Start it with `npm run worker:dev`.",
    );
  }
  console.log(`  counts:`, counts);

  for (const job of await confidoWebhooksQueue.getFailed(0, 10)) {
    console.log(`\n  FAILED ${job.id}`);
    console.log(`    ${JSON.stringify(job.data)}`);
    console.log(`    ${(job.failedReason ?? "").slice(0, 300)}`);
  }

  const waiting = await confidoWebhooksQueue.getWaiting(0, 10);
  for (const job of waiting) {
    console.log(`  WAITING ${job.data.eventType}  ${job.data.transactionId ?? ""}`);
  }

  await confidoWebhooksQueue.close();
  await redisConnection.quit();
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
