import { Worker } from "bullmq";
import { processConfidoWebhook } from "../../modules/finance/confido/confido-webhooks.service";
import { redisConnection } from "../connection";
import { CONFIDO_WEBHOOKS_QUEUE, type ConfidoWebhookJob } from "../queues";

/**
 * Handles Confido webhooks off the HTTP request.
 *
 * The route has five seconds before Confido marks a delivery failed, and every
 * event needs a query back to Confido because the payloads carry only an id.
 * Doing that inline would spend the whole budget on someone else's latency.
 *
 * Idempotency lives in `processConfidoWebhook`, keyed on the event id already
 * claimed in `payment_webhook_events` — BullMQ is at-least-once, so a redelivered
 * job has to be a no-op.
 */
export const createConfidoWebhookWorker = () =>
  new Worker<ConfidoWebhookJob>(
    CONFIDO_WEBHOOKS_QUEUE,
    async (job) => {
      await processConfidoWebhook(job.data);
    },
    // Own connection: BullMQ blocking consumers monopolize theirs, so each
    // Worker gets a duplicate rather than sharing.
    { connection: redisConnection.duplicate() },
  );
