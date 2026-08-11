import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { invoices, paymentMethodEnum } from "./invoices";
import { staff } from "./staff";

/**
 * The payment ledger. Partial payments mean N rows per invoice;
 * `invoices.amountPaid` is the cached fold of this table.
 *
 * `amountOperating` / `amountTrust` are the load-bearing columns. The Reports
 * tab needs "filing fees collected" and "held in trust pending"; if a $1,500
 * trust / $500 operating invoice receives $600, nothing else in the data says
 * how much of that was trust money. Pro-rating at read time is cheap but
 * legally wrong — IOLTA funds must be tracked, not estimated. The service
 * pro-rates as the default when the caller omits the split (so the simple
 * Record-payment form still works), but the number is then stored, auditable
 * and correctable.
 */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
    amountOperating: numeric("amount_operating", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    amountTrust: numeric("amount_trust", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),

    paymentDate: date("payment_date").notNull(),
    method: paymentMethodEnum("method").notNull(),
    /** Cheque number, wire reference, gateway transaction id. */
    reference: text("reference"),
    notes: text("notes"),

    recordedById: uuid("recorded_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("invoice_payments_invoice_idx").on(table.invoiceId),
    index("invoice_payments_org_date_idx").on(
      table.organizationId,
      table.paymentDate,
    ),
    check("invoice_payments_amount_positive", sql`${table.amount} > 0`),
    check(
      "invoice_payments_split_balances",
      sql`${table.amountOperating} + ${table.amountTrust} = ${table.amount}`,
    ),
  ],
);

export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
