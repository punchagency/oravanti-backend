import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Inbound SMS, which in practice means opt-out keywords.
 *
 * The firm has no SMS inbox — this is not a conversation feature. It exists so
 * that a STOP is evidence rather than a side effect: the message that caused a
 * contact to be opted out is retrievable, with its exact wording and arrival
 * time, which is what a TCPA question actually asks for.
 *
 * `organizationId` is nullable and unlinked because the platform sends from ONE
 * shared number. An inbound message identifies the sender's phone, not which
 * firm they were replying to, and the same number may be on file for leads at
 * several firms. Attributing it to one would be a guess, and the opt-out it
 * triggers is not per-firm anyway — see consent.service.ts, which applies it
 * across every matching row in every organization, because opting out of a
 * sender number means that number stops texting you.
 *
 * That nullable organization is also why this table carries NO RLS policy: a
 * row scoped to no organization cannot be filtered by one. It is reached only
 * through `systemDb` with an explicit E.164 predicate. The same exception, for
 * the same reason, as email-suppressions.
 *
 * `providerMessageId` is unique so Twilio redelivering a webhook cannot opt
 * someone out twice or double-count the affected rows.
 */
export const smsInboundMessages = pgTable(
  "sms_inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Recorded when it can be determined, purely for support. Never used to scope. */
    organizationId: text("organization_id"),

    /** E.164, normalised on receipt. */
    fromPhone: text("from_phone").notNull(),
    toPhone: text("to_phone").notNull(),

    /** Exactly what they sent, unmodified — this is the evidence. */
    body: text("body"),
    /** "STOP" | "START" | "HELP", or null when it matched no keyword. */
    keyword: text("keyword"),

    /** Twilio MessageSid. Unique: the webhook is at-least-once. */
    providerMessageId: text("provider_message_id").notNull().unique(),

    /** What the keyword actually changed, e.g. { leads: 2, clients: 1 }. */
    affected: jsonb("affected").notNull().default({}),

    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => [
    index("sms_inbound_from_idx").on(table.fromPhone, table.receivedAt),
  ],
);

export type SmsInboundMessage = typeof smsInboundMessages.$inferSelect;
export type NewSmsInboundMessage = typeof smsInboundMessages.$inferInsert;
