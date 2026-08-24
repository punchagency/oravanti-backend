import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { invoices } from "./invoices";
import { staff } from "./staff";

export const followupChannelEnum = pgEnum("invoice_followup_channel", [
  "email",
  "sms",
  "both",
]);

/**
 * A record of every payment chase sent to a client.
 *
 * The recipient address is snapshotted rather than read back through the
 * client row, so the record stays defensible after the client changes their
 * email or phone number.
 */
export const invoiceFollowups = pgTable(
  "invoice_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    channel: followupChannelEnum("channel").notNull(),
    message: text("message").notNull(),

    /** The address actually used, snapshotted at send time. */
    sentToEmail: text("sent_to_email"),
    sentToPhone: text("sent_to_phone"),

    /**
     * Both record whether the provider ACCEPTED the message, which is why
     * `sendFollowUp` dispatches inline rather than queueing: a chase is a staff
     * member pressing send and then reading a row that claims what happened,
     * and a queued send could only record an intention.
     *
     * A later bounce or carrier failure moves the corresponding `notifications`
     * row to `failed` via the provider webhook; it does not rewrite these,
     * because "we sent it on the 4th" stays true even if it later bounced.
     */
    emailDelivered: boolean("email_delivered").notNull().default(false),
    smsDelivered: boolean("sms_delivered").notNull().default(false),

    sentById: uuid("sent_by_id").references(() => staff.id),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
  },
  (table) => [
    index("invoice_followups_invoice_idx").on(table.invoiceId, table.sentAt),
  ],
);

export type InvoiceFollowup = typeof invoiceFollowups.$inferSelect;
export type NewInvoiceFollowup = typeof invoiceFollowups.$inferInsert;
export type FollowupChannel = (typeof followupChannelEnum.enumValues)[number];
