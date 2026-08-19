import { and, isNull, lt, sql } from "drizzle-orm";
import { systemDb } from "../../../db/client";
import { paymentWebhookEvents } from "../../../db/schema/payment-webhook-events";
import { LogEvent } from "../../../lib/logging/events";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("confido-staleness");

/**
 * Watches for webhook events that were accepted but never handled.
 *
 * This exists because of a failure we actually hit. Money was arriving from
 * Confido and never reaching the ledger, and every outward sign was healthy:
 * the endpoint returned 200, events were claimed in `payment_webhook_events`,
 * and `npm run worker:dev` was present in `ps`. What was true was that the
 * watcher was alive while its child had stopped consuming — nine jobs queued,
 * zero workers attached, and nothing anywhere said so.
 *
 * The only signal was rows sitting at `processed_at IS NULL`, which is exactly
 * what that column was added for. Nothing was reading it. This does.
 *
 * The shape of the failure is what makes it worth a sweep rather than a metric
 * on the request path: the HTTP side is working perfectly. It is the half after
 * the acknowledgement that is broken, and by definition nobody is waiting on a
 * response to notice.
 */

/**
 * How long an event may sit unhandled before it counts as stuck.
 *
 * Handling is a queue hop and one API call — seconds. Five minutes is generous
 * enough that a slow retry or a brief Redis blip does not cry wolf, and short
 * enough that a dead worker is caught within one sweep rather than at close of
 * business.
 */
const STALE_AFTER_MS = 5 * 60 * 1000;

export interface WebhookStaleness {
  stale: number;
  /** Age of the oldest unhandled event, in minutes. */
  oldestMinutes: number | null;
}

/**
 * Count events accepted but not yet handled, beyond the grace period.
 *
 * Deliberately not organization-scoped: `payment_webhook_events` is not either,
 * because the row is written before the tenant is known. A stuck queue is a
 * platform problem rather than a firm's, and the firms affected are whichever
 * ones happened to take a payment.
 */
export const findStaleWebhookEvents = async (
  staleAfterMs = STALE_AFTER_MS,
): Promise<WebhookStaleness> => {
  const cutoff = new Date(Date.now() - staleAfterMs);

  const [row] = await systemDb
    .select({
      stale: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${paymentWebhookEvents.receivedAt})`,
    })
    .from(paymentWebhookEvents)
    .where(
      and(
        isNull(paymentWebhookEvents.processedAt),
        lt(paymentWebhookEvents.receivedAt, cutoff),
      ),
    );

  const stale = row?.stale ?? 0;
  return {
    stale,
    oldestMinutes:
      stale > 0 && row?.oldest
        ? Math.round((Date.now() - new Date(row.oldest).getTime()) / 60_000)
        : null,
  };
};

/**
 * Report stuck events, loudly.
 *
 * Logs at `error` rather than `warn` because the thing it detects is payments
 * not being recorded, and a firm's ledger silently diverging from their bank is
 * not a warning. Silent when there is nothing wrong, so the presence of the line
 * is itself the signal.
 */
export const reportStaleWebhookEvents = async (): Promise<WebhookStaleness> => {
  const result = await findStaleWebhookEvents();

  if (result.stale > 0) {
    // "error" spelled out rather than log.failure(): there is no exception here
    // to attach, only a detected condition. The level is still error because
    // the condition is a ledger diverging from a bank account.
    log.at(
      "error",
      LogEvent.PAYMENT_WEBHOOK_STALE_EVENTS_FOUND,
      { stale: result.stale, oldestMinutes: result.oldestMinutes },
      `${result.stale} webhook event(s) accepted but never handled, ` +
        `oldest ${result.oldestMinutes} minute(s) ago. Payments may not be ` +
        `reaching the ledger — check the worker is consuming ` +
        `(npx tsx scripts/q-inspect.ts).`,
    );
  }

  return result;
};
