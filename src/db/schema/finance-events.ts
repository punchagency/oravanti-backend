import {
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";
import { clients } from "./clients";
import { invoices, paymentMethodEnum } from "./invoices";
import { staff } from "./staff";
import { timeEntries } from "./time-entries";

export const financeEventTypeEnum = pgEnum("finance_event_type", [
  "invoice_created",
  "invoice_sent",
  "invoice_updated",
  "invoice_voided",
  "payment_recorded",
  "invoice_paid",
  "invoice_partially_paid",
  "payment_followup_sent",
  "time_entry_logged",
  "time_entry_approved",
  "time_entry_rejected",
  "billing_rate_changed",
]);

/**
 * Append-only activity trail for the finance module. Nothing here updates or
 * deletes an event and no route exposes a path that would — the trail is the
 * record of what happened, so a correction is a new event, never an edit.
 *
 * This is a separate table from `case_events` rather than an extension of it:
 *
 *   1. `case_events.case_id` is notNull with onDelete cascade. Invoices need
 *      not have a case, so much of the finance trail would have nowhere to go
 *      — and a cascade would delete payment history along with the matter.
 *      Every FK here is `set null`: a financial record must outlive the matter.
 *   2. `case_events` is indexed on (case_id, created_at), precisely the wrong
 *      shape for the org-wide activity feed on the Invoicing tab.
 *   3. Adding a dozen billing values to `caseEventTypeEnum` would make the
 *      case-detail timeline start rendering payment rows.
 *
 * When an invoice *does* have a caseId, the service additionally calls
 * `logCaseEvent` so the matter timeline shows it — the two trails complement
 * each other rather than competing.
 */
export const financeEvents = pgTable(
  "finance_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    invoiceId: uuid("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    timeEntryId: uuid("time_entry_id").references(() => timeEntries.id, {
      onDelete: "set null",
    }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),

    eventType: financeEventTypeEnum("event_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),

    // Promoted out of `metadata` on purpose: the recent-activity feed displays
    // and sorts on them, and reading them from jsonb costs a cast per row and
    // forbids an index.
    amount: numeric("amount", { precision: 15, scale: 4 }),
    paymentMethod: paymentMethodEnum("payment_method"),

    metadata: jsonb("metadata"),

    actorId: uuid("actor_id").references(() => staff.id),
    /** Denormalized so the trail still reads correctly after a staff member leaves. */
    actorNameSnapshot: text("actor_name_snapshot"),
    ipAddress: text("ip_address"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("finance_events_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("finance_events_invoice_idx").on(table.invoiceId, table.createdAt),
  ],
);

export type FinanceEvent = typeof financeEvents.$inferSelect;
export type NewFinanceEvent = typeof financeEvents.$inferInsert;
export type FinanceEventType =
  (typeof financeEventTypeEnum.enumValues)[number];
