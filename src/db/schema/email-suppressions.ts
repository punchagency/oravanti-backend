import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const emailSuppressionReasonEnum = pgEnum("email_suppression_reason", [
  "bounced",
  "complained",
  "provider_suppressed",
  "manual",
]);

/**
 * Addresses we must stop emailing.
 *
 * A LOCAL MIRROR, not the source of truth. Resend maintains its own suppression
 * list and emits suppression.added / suppression.removed / email.suppressed;
 * this table follows those events. Mirroring buys two things a remote list
 * cannot: gating a send is a local read on the hot path instead of an API call,
 * and the UI can say *why* an email was not sent instead of showing silence.
 *
 * PLATFORM-WIDE, deliberately — `organizationId` is nullable and carries no
 * foreign key. Sender domain reputation is shared by every firm on the
 * platform, so a hard bounce or a spam complaint is a fact about the address,
 * not about one firm's relationship with it. Continuing to send to a known-bad
 * address is what gets a sending domain throttled and eventually suspended, and
 * that failure would take email down for everyone. One address is never worth
 * that.
 *
 * The same reasoning, and the same access rule, as the SMS opt-out on a shared
 * sender number: reached only through `systemDb` with an explicit lowercased
 * email predicate, and carrying no RLS policy, because a row scoped to no
 * organization cannot be filtered by one. See sms-inbound-messages.ts.
 *
 * Suppressed means: a row exists for the address with `removedAt` null.
 * Rows are kept after removal rather than deleted, so "this address bounced in
 * March and was reinstated in April" stays answerable.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Stored lowercased. Every read must lowercase before comparing. */
    email: text("email").notNull().unique(),

    reason: emailSuppressionReasonEnum("reason").notNull(),
    /** The provider event that caused this, for tracing back. */
    providerEventId: text("provider_event_id"),

    /**
     * Nullable and unlinked: which firm happened to trigger the bounce is
     * incidental to a fact that applies to all of them. Recorded when known,
     * purely for support.
     */
    organizationId: text("organization_id"),

    suppressedAt: timestamp("suppressed_at").notNull().defaultNow(),
    /** Set when the provider reports the address reinstated. Null while suppressed. */
    removedAt: timestamp("removed_at"),
  },
  (table) => [
    index("email_suppressions_active_idx").on(table.email, table.removedAt),
  ],
);

export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type NewEmailSuppression = typeof emailSuppressions.$inferInsert;
export type EmailSuppressionReason =
  (typeof emailSuppressionReasonEnum.enumValues)[number];
