import { and, eq, isNull } from "drizzle-orm";
import { systemDb } from "../../../db/client";
import { paymentWebhookEvents } from "../../../db/schema/payment-webhook-events";
import { enqueueConfidoWebhook } from "../../../queue/queues";
import {
  markWebhookSeen,
  organizationForConfidoFirm,
  refreshStatus,
} from "../../settings/payments/payment-settings.service";
import { getConfidoClient, isConfidoConfigured } from "./confido.client";
import type { ConfidoWebhookEvent } from "./confido.types";

/**
 * Confido webhooks.
 *
 * Three properties of their delivery shape the design, and none of them match
 * the Stripe-silhouetted handler in `payment-webhooks.service.ts`:
 *
 *   1. **A five-second budget.** A slower answer is marked failed, and repeated
 *      failures over 24 hours disable the webhook URL — recoverable only from
 *      their portal. So the HTTP path does no network I/O at all: verify, claim,
 *      enqueue, return.
 *   2. **The body is an array** of heterogeneous events, not one event.
 *   3. **Payloads are thin.** `firm.updated` carries `{ firm: { id } }` and
 *      nothing else, so the state must be fetched rather than read. That is also
 *      what makes out-of-order delivery harmless: every handler converges on the
 *      current truth instead of writing whatever the payload happened to say.
 *
 * This is the single Confido endpoint. Confido posts every event type to one
 * Partner-level URL, so slice 2's transaction events land here too.
 */

export const CONFIDO_PROVIDER = "confido";

/** Event types slice 1 acts on. Anything else is acknowledged and dropped. */
const HANDLED_TYPES = new Set(["firm.updated"]);

export type ConfidoWebhookOutcome = {
  received: number;
  claimed: number;
  ignored: number;
};

/** Narrow an unknown parsed body to the events we can act on. */
const asEvents = (parsed: unknown): ConfidoWebhookEvent[] => {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(
    (e): e is ConfidoWebhookEvent =>
      Boolean(e) &&
      typeof e === "object" &&
      typeof (e as ConfidoWebhookEvent).type === "string" &&
      typeof (e as ConfidoWebhookEvent).eventId === "string",
  );
};

/**
 * The HTTP path. Verifies, claims, enqueues — and touches no network.
 *
 * Throws on an unverifiable signature so the route can answer 401. Everything
 * else returns a summary and a 200: an unrecognised event type is not an error,
 * and answering non-2xx would make Confido retry something we will never handle.
 */
export const receiveConfidoWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
): Promise<ConfidoWebhookOutcome> => {
  if (!isConfidoConfigured()) {
    // Nothing to verify with, so nothing can be trusted. Refusing is the only
    // safe answer for an unauthenticated endpoint.
    throw new Error("Confido is not configured");
  }

  if (!getConfidoClient().verifyWebhook(rawBody, signature)) {
    throw new Error("Invalid webhook signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Malformed webhook body");
  }

  const events = asEvents(parsed);
  let claimed = 0;
  let ignored = 0;

  for (const event of events) {
    if (!HANDLED_TYPES.has(event.type)) {
      // Deliberately no row. Slice 2 adds the transaction branches, and it must
      // find those events unclaimed rather than pre-marked as processed.
      ignored += 1;
      continue;
    }

    try {
      await systemDb.insert(paymentWebhookEvents).values({
        provider: CONFIDO_PROVIDER,
        eventId: event.eventId,
        eventType: event.type,
      });
    } catch {
      // The unique index fired: a redelivery. Confido reuses the event id on
      // resend, which is exactly what makes this safe.
      continue;
    }

    await enqueueConfidoWebhook({
      eventId: event.eventId,
      eventType: event.type,
      firmId: event.firmId,
    });
    claimed += 1;
  }

  return { received: events.length, claimed, ignored };
};

/**
 * The worker's side. Runs outside any request context.
 *
 * `db` would silently fall back to `systemDb` here, so the services this calls
 * use `systemDb` explicitly and resolve the organization from `confido_firm_id`.
 * A wrong mapping would be a cross-tenant write, which is why that column is
 * uniquely indexed.
 */
export const processConfidoWebhook = async (job: {
  eventId: string;
  eventType: string;
  firmId: string;
}): Promise<void> => {
  const organizationId = await organizationForConfidoFirm(job.firmId);

  if (!organizationId) {
    // Not an error. A Partner-level URL legitimately receives events for firms
    // created outside this application.
    await markProcessed(job.eventId);
    return;
  }

  await markWebhookSeen(organizationId);

  if (job.eventType === "firm.updated") {
    await refreshStatus(organizationId);
  }

  await markProcessed(job.eventId);
};

/**
 * Closes the event out.
 *
 * Only ever moves a null `processed_at` forward, so a redelivery that raced
 * ahead cannot rewind the timestamp. A row left null is one that crashed
 * mid-handle — visible rather than silently replayed.
 */
const markProcessed = async (eventId: string): Promise<void> => {
  await systemDb
    .update(paymentWebhookEvents)
    .set({ processedAt: new Date() })
    .where(
      and(
        eq(paymentWebhookEvents.provider, CONFIDO_PROVIDER),
        eq(paymentWebhookEvents.eventId, eventId),
        isNull(paymentWebhookEvents.processedAt),
      ),
    );
};
