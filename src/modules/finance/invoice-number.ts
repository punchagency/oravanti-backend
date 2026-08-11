import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { invoiceNumberSequences } from "../../db/schema/invoice-number-sequences";
import { dayjs } from "../../utils/date";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";

/**
 * Allocate the next invoice number for a firm and year: `INV-2026-0042`.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` is one statement, so it takes a
 * row-level lock on the counter and concurrent callers serialise on it, each
 * receiving a distinct value. There is no read-then-write window for a second
 * transaction to slip into.
 *
 * This deliberately does not follow `generateCaseNumber` in cases.service.ts,
 * which SELECTs every matching row, folds max+1 in JS, and relies on a unique
 * constraint to catch the race — surfacing the loser as an unhandled 500 rather
 * than a retry.
 *
 * MUST be called inside the invoice-creation transaction, so the number and the
 * invoice commit together.
 *
 * Trade-off, stated plainly: a rolled-back transaction burns a number and
 * leaves a gap in the sequence. That is the right trade for invoices — auditors
 * require numbers to be monotonic and never reused; they do not require them to
 * be gapless. Allocating outside the transaction would produce more gaps, not
 * fewer.
 *
 * A plain Postgres SEQUENCE cannot express this: sequences are per-database,
 * not per (organization, year).
 */
export const allocateInvoiceNumber = async (
  organizationId: string,
  year: number,
): Promise<string> => {
  const [row] = await db
    .insert(invoiceNumberSequences)
    .values({ organizationId, year, lastValue: 1 })
    .onConflictDoUpdate({
      target: [
        invoiceNumberSequences.organizationId,
        invoiceNumberSequences.year,
      ],
      set: { lastValue: sql`${invoiceNumberSequences.lastValue} + 1` },
    })
    .returning({ n: invoiceNumberSequences.lastValue });

  return formatInvoiceNumber(year, row!.n);
};

/** Split out so the tests can assert the format without touching the database. */
export const formatInvoiceNumber = (year: number, sequence: number): string =>
  `INV-${year}-${String(sequence).padStart(4, "0")}`;

/**
 * The year an invoice created *now* belongs to, in the firm's timezone.
 *
 * Using the server's year would number an invoice issued at 23:00 on Dec 31 in
 * Los Angeles as INV-2027-0001.
 */
export const currentInvoiceYear = async (
  organizationId: string,
): Promise<number> => {
  const tz = await getFirmTimezone(organizationId);
  return Number(dayjs().tz(tz).format("YYYY"));
};
