import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff } from "./staff";

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "sms",
  "in_app",
]);

/**
 * Why a notification exists, which is what decides whether firm preferences may
 * suppress it.
 *
 * `transactional` — the recipient asked for it or must receive it to proceed: a
 * questionnaire link, a booking link, a payment link, a signature request. Firm
 * notification preferences do NOT apply, because a firm toggling "email off"
 * must not silently break its own intake.
 *
 * `preference` — an alert about something that happened, almost always
 * staff-facing. Every channel is gated on the firm's toggles.
 *
 * One real-world moment can produce both: a payment yields a client receipt
 * (transactional) and a staff alert (preference). They are separate events
 * precisely so the second can be switched off without losing the first.
 */
export const notificationTierEnum = pgEnum("notification_tier", [
  "transactional",
  "preference",
]);

/**
 * `skipped` is the load-bearing one. A notification we deliberately did not
 * send is recorded with a reason, rather than never existing — that is the
 * difference between "we never sent" and "we sent and it bounced", which the
 * previous fire-and-forget email calls could not tell apart.
 *
 * `sent` means the provider accepted the message. `delivered` means the
 * provider later said it reached the recipient, which only arrives via a
 * webhook — so an email in development, where the SMTP transport has no
 * callbacks, correctly stops at `sent` forever.
 */
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "skipped",
  "cancelled",
]);

export const notificationRecipientTypeEnum = pgEnum(
  "notification_recipient_type",
  ["lead", "client", "staff", "user", "external"],
);

/**
 * Every message the system sends, or decides not to send: one row per event ×
 * recipient × channel.
 *
 * Before this table, ~30 services called the mailer as
 * `sendEmail({...}).catch(console.error)`. Nothing was recorded, so a firm
 * asking "did my client get the questionnaire?" had no answer — not from the
 * app, and not from the logs once they rotated.
 *
 * Two columns are deliberately `text` where an enum would be the reflex:
 *
 *   `event` — the vocabulary of things worth telling someone about grows with
 *   every feature, and each addition would otherwise be a migration. The
 *   in-repo cautionary tale is `invoice_delivery_channel`, frozen as ["email"],
 *   which every later SMS discussion had to work around. Validity is enforced
 *   by the TypeScript catalog in src/notifications/events.ts.
 *
 *   `skipReason` — same reasoning. New gates keep appearing (consent, firm
 *   toggle, suppression, unparseable address) and each is a new reason.
 *
 * The scenario columns (leadId, clientId, …) are raw uuids with NO foreign
 * keys, following the existing unlinked-reference idiom in `leads` and
 * `consultations`. A delivery record must outlive the thing it was about:
 * cascading a lead deletion into its own audit trail would destroy the evidence
 * exactly when someone is asking what was sent.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    /** Catalog key from src/notifications/events.ts. Text, not an enum — see above. */
    event: text("event").notNull(),
    tier: notificationTierEnum("tier").notNull(),
    channel: notificationChannelEnum("channel").notNull(),
    status: notificationStatusEnum("status").notNull().default("pending"),

    recipientType: notificationRecipientTypeEnum("recipient_type").notNull(),
    /** Null for `external` recipients, which have an address but no row. */
    recipientId: uuid("recipient_id"),
    recipientName: text("recipient_name"),
    /**
     * The address actually used, snapshotted at send time: an email address, or
     * a phone number already normalised to E.164. Null on a row skipped for
     * having no usable address, which is itself the finding.
     */
    recipientAddress: text("recipient_address"),

    subject: text("subject"),
    /** SMS text or in-app body. Email HTML is not stored — see `payload`. */
    body: text("body"),
    /**
     * The template context.
     *
     * Stored instead of rendered email HTML because it is smaller, greppable,
     * and re-renders identically on a retry. Storing the HTML would freeze a
     * template bug into the record and bloat the table for no gain.
     */
    payload: jsonb("payload").notNull().default({}),

    /** Twilio MessageSid / Resend email id. How a delivery webhook finds this row. */
    providerMessageId: text("provider_message_id"),
    /** The provider's own last word, kept raw for support conversations. */
    providerStatus: text("provider_status"),
    failureReason: text("failure_reason"),
    /** Why we chose not to send. Text, not an enum — see above. */
    skipReason: text("skip_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),

    /**
     * Idempotency key, unique per organization. Paired with the partial unique
     * index below, this makes "schedule this reminder" safe to call twice: the
     * second insert is a no-op in the database rather than a check in whichever
     * caller remembered to write one.
     */
    dedupeKey: text("dedupe_key"),
    /** BullMQ job id, so a scheduled send can be cancelled. Mirrors questionnaire_sends.reminderJobId. */
    jobId: text("job_id"),

    // Scenario references. Raw uuids, no FKs — see the header.
    leadId: uuid("lead_id"),
    clientId: uuid("client_id"),
    caseId: uuid("case_id"),
    invoiceId: uuid("invoice_id"),
    consultationId: uuid("consultation_id"),

    /** The staff member whose action triggered this, when there was one. */
    sentById: uuid("sent_by_id").references(() => staff.id),

    /** When it should go out. Null means immediately. */
    sendAt: timestamp("send_at"),
    /** When the provider accepted it. */
    sentAt: timestamp("sent_at"),
    /** When the provider confirmed it arrived. Only ever set by a webhook. */
    deliveredAt: timestamp("delivered_at"),
    /** In-app only: when the recipient opened it. */
    readAt: timestamp("read_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("notifications_org_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    index("notifications_recipient_idx").on(
      table.organizationId,
      table.recipientType,
      table.recipientId,
      table.createdAt.desc(),
    ),
    /** Delivery webhooks arrive knowing only the provider's id. */
    index("notifications_provider_message_idx").on(table.providerMessageId),
    uniqueIndex("notifications_dedupe_uidx")
      .on(table.organizationId, table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    /** Drives the sweep that recovers scheduled sends lost from Redis. */
    index("notifications_pending_idx")
      .on(table.status, table.sendAt)
      .where(sql`${table.status} IN ('pending', 'queued')`),
    index("notifications_lead_idx").on(table.organizationId, table.leadId),
    index("notifications_invoice_idx").on(table.organizationId, table.invoiceId),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationChannel =
  (typeof notificationChannelEnum.enumValues)[number];
export type NotificationTier = (typeof notificationTierEnum.enumValues)[number];
export type NotificationStatus =
  (typeof notificationStatusEnum.enumValues)[number];
export type NotificationRecipientType =
  (typeof notificationRecipientTypeEnum.enumValues)[number];
