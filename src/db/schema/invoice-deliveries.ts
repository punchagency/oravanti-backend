import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { invoices } from "./invoices";
import { staff } from "./staff";

export const deliveryChannelEnum = pgEnum("invoice_delivery_channel", [
  "email",
]);

export const deliveryStatusEnum = pgEnum("invoice_delivery_status", [
  "pending",
  "sent",
  "failed",
]);

/**
 * What the client was sent.
 *
 * `invoice` is the invoice itself. `schedule_update` is a payment plan being
 * set or revised on an invoice they already hold — same archived document, a
 * different thing to say about it.
 *
 * Kept as a column rather than inferred from timing because `canChaseInvoice`
 * asks "has this invoice reached the client", and only an `invoice` delivery
 * answers that. A schedule update proves they received *something*, not that
 * they ever got the bill.
 */
export const deliveryKindEnum = pgEnum("invoice_delivery_kind", [
  "invoice",
  "schedule_update",
]);

/**
 * A record of each attempt to deliver an invoice to a client.
 *
 * The point of the table is that it stays truthful when a send FAILS. A row is
 * written as `pending` before the email goes out and updated afterwards, so a
 * crash mid-send leaves evidence rather than silence, and a bounce leaves a
 * reason rather than an invoice that merely claims to have been sent.
 *
 * `status = 'sent'` means the email provider ACCEPTED the message, not that it
 * reached a human. Bounces are asynchronous and no provider webhook is wired
 * yet, so `deliveredAt` records the handoff. Naming it anything stronger would
 * repeat the mistake this table exists to fix.
 *
 * Deliberately separate from `invoice_followups` despite the overlapping
 * columns: a follow-up is a chase *message* (free text, a channel), a delivery
 * carries a *document* (the archived PDF). Merging them would give one table
 * two optional halves. They share a column vocabulary so unifying later stays
 * cheap if a third delivery kind appears.
 */
export const invoiceDeliveries = pgTable(
  "invoice_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    channel: deliveryChannelEnum("channel").notNull().default("email"),
    kind: deliveryKindEnum("kind").notNull().default("invoice"),

    /** Snapshotted, so the record stays defensible after the client moves address. */
    recipientEmail: text("recipient_email").notNull(),

    /**
     * R2 key of the EXACT bytes sent. Regenerating the PDF later could differ
     * if the invoice data moved, and "here is what we sent you" is the whole
     * point of archiving it.
     */
    documentKey: text("document_key"),

    status: deliveryStatusEnum("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    /** Incremented per retry; anticipates a BullMQ retry queue. */
    attemptCount: integer("attempt_count").notNull().default(1),

    sentById: uuid("sent_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    /** When the provider accepted it — null while pending or after a failure. */
    deliveredAt: timestamp("delivered_at"),
  },
  (table) => [
    index("invoice_deliveries_invoice_idx").on(table.invoiceId, table.createdAt),
    index("invoice_deliveries_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export type InvoiceDelivery = typeof invoiceDeliveries.$inferSelect;
export type NewInvoiceDelivery = typeof invoiceDeliveries.$inferInsert;
export type DeliveryStatus = (typeof deliveryStatusEnum.enumValues)[number];
export type DeliveryKind = (typeof deliveryKindEnum.enumValues)[number];
