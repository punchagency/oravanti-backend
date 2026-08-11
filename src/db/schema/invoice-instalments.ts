import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { invoices } from "./invoices";

/**
 * A payment schedule: the invoice total cut into dated slices.
 *
 * Payments are deliberately NOT linked to a row here. `invoices.amount_paid`
 * stays the only stored paid figure, and each instalment's paid amount is
 * derived by walking the schedule in due-date order — so a per-instalment
 * figure can never drift from the invoice's own. That derivation lives in
 * exactly two places, `dues.ts` (SQL) and `instalments.service.ts` (its
 * TypeScript twin), and nowhere else.
 *
 * `sequence` is renumbered 1..N into due-date order on every write, so the two
 * orderings are always identical and the window function has a deterministic
 * tiebreaker.
 *
 * **The database does not guarantee that the instalments sum to the invoice
 * total.** That rule is cross-row and cross-table, so a `check()` cannot
 * express it and the only real backstop would be a DEFERRABLE constraint
 * trigger, which drizzle cannot emit. `assertScheduleBalances()` in
 * instalments.service.ts is the enforcement, inside the same transaction as
 * every write that could break it. Do not assume the schema is guarding this.
 */
export const invoiceInstalments = pgTable(
  "invoice_instalments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Carried rather than reached through `invoices`, so the RLS policy is a
     * plain column comparison instead of a subquery — the same reasoning as
     * `invoice_line_items`.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    /** 1-based, always in due-date order. See the note above. */
    sequence: integer("sequence").notNull(),
    dueDate: date("due_date").notNull(),
    /** Written through `money()` at 2dp, like line items. */
    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invoice_instalments_invoice_seq_uidx").on(
      table.invoiceId,
      table.sequence,
    ),
    /**
     * The dues query reaches instalments by `invoice_id` and then orders by
     * `due_date` within that partition, so this is the shape it wants. An
     * (organization_id, due_date) index would serve no query in the module.
     */
    index("invoice_instalments_invoice_due_idx").on(
      table.invoiceId,
      table.dueDate,
    ),
    check("invoice_instalments_amount_positive", sql`${table.amount} > 0`),
    check("invoice_instalments_sequence_positive", sql`${table.sequence} > 0`),
  ],
);

export type InvoiceInstalment = typeof invoiceInstalments.$inferSelect;
export type NewInvoiceInstalment = typeof invoiceInstalments.$inferInsert;
