import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Every webhook a payment provider has delivered, by its own event id.
 *
 * Providers deliver at least once. Without a record of what has already been
 * handled, a redelivery replays whatever the handler does — and here that means
 * money on the ledger.
 *
 * The Dropbox Sign handler achieves idempotency purely through terminal-state
 * guards (`if (agreement.status === "signed") return`), and that precedent does
 * NOT transfer:
 *
 *   - its payload carries no event id, so there is nothing to store
 *   - signing has a terminal state to guard on; payments do not. A second
 *     `payment_intent.succeeded` for a *different* intent is a legitimate second
 *     payment, so "this invoice already has payments" cannot be the check.
 *
 * Deliberately NOT organization-scoped and NOT under RLS. The row is written
 * before the org is known — the whole point is to reject a duplicate as early
 * as possible, and looking up the invoice first would do work the duplicate
 * check exists to avoid. It holds no client data: a provider name, an opaque
 * id, and a timestamp.
 */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    /** The provider's event id. */
    eventId: text("event_id").notNull(),
    /** What it was, for reading the log back. Not acted on. */
    eventType: text("event_type"),
    /**
     * Null while being processed, set when handling finished. A row that stays
     * null is one that crashed mid-handle — visible rather than silent, and the
     * same reasoning as the `pending` delivery row in deliveries.service.
     */
    processedAt: timestamp("processed_at"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_webhook_events_provider_event_uidx").on(
      table.provider,
      table.eventId,
    ),
    index("payment_webhook_events_received_idx").on(table.receivedAt),
  ],
);

export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
export type NewPaymentWebhookEvent = typeof paymentWebhookEvents.$inferInsert;
