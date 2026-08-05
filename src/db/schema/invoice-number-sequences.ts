import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * One counter row per firm per year. The row itself is the lock: allocation is
 * a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which takes a
 * row-level lock, so concurrent invoice creations serialise on it and each
 * receives a distinct value with no read-then-write window.
 *
 * This exists instead of the `SELECT max(...) + 1` approach used by
 * `generateCaseNumber`, which is racy (the unique constraint is what stops the
 * duplicate, surfacing as an unhandled 500 rather than a retry).
 *
 * A plain Postgres SEQUENCE cannot express this — sequences are per-database,
 * not per (organization, year).
 *
 * See `src/modules/finance/invoice-number.ts`.
 */
export const invoiceNumberSequences = pgTable(
  "invoice_number_sequences",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    year: integer("year").notNull(),
    lastValue: integer("last_value").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.year] })],
);

export type InvoiceNumberSequence = typeof invoiceNumberSequences.$inferSelect;
export type NewInvoiceNumberSequence =
  typeof invoiceNumberSequences.$inferInsert;
