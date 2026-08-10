import { SQL, and, eq, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { invoiceInstalments } from "../../db/schema/invoice-instalments";
import { invoices } from "../../db/schema/invoices";

/**
 * Every unpaid slice of money the firm is owed, one row per slice, dated by when
 * THAT slice is due.
 *
 * An invoice with a payment schedule contributes one row per instalment; an
 * invoice without one contributes a single synthetic row for its whole balance,
 * so callers never have to branch on whether a schedule exists.
 *
 * This module is the ONLY place `invoice_instalments` may be joined. Everywhere
 * else reads `invoices.next_due_date` instead. The reason is fan-out: `getStats`
 * and `fetchSummary` compute a dozen unrelated figures in one SELECT, and
 * joining a 1:N table multiplies every one of them — the same bug
 * `fetchTrustReconciliation` uses two scalar subqueries to avoid.
 */

/**
 * How much of each instalment is still owed.
 *
 * With `c_i` the running total of instalment amounts in due-date order and `P`
 * the invoice's `amount_paid`, an instalment still owes
 * `LEAST(GREATEST(c_i - P, 0), amount_i)` — zero once the payments have run past
 * it, its full amount before they reach it, and the shortfall in between.
 * Overpayment (`P > total`) gives zero everywhere rather than a negative.
 *
 * ROWS, not the default RANGE, and the frame is stated rather than assumed.
 *
 * RANGE treats rows equal in every ORDER BY column as peers and hands each of
 * them the cumulative total through the whole group. `sequence` is in the
 * ordering and is unique per invoice, so today no two rows are ever peers and
 * RANGE would in fact agree — this is not currently a live bug, and a test
 * cannot reach it while the unique index holds.
 *
 * It is spelled out because the correctness would otherwise rest silently on
 * that tiebreaker. Drop `sequence` from the ORDER BY as redundant — dates look
 * unique until two instalments land on the same day — and under RANGE two $500
 * instalments against a $500 payment would each report $500 outstanding, a
 * receivable that does not exist. Under ROWS the same edit stays correct.
 */
const outstandingPerInstalment = sql`
  least(
    greatest(
      sum(${invoiceInstalments.amount}) OVER (
        PARTITION BY ${invoiceInstalments.invoiceId}
        ORDER BY ${invoiceInstalments.dueDate}, ${invoiceInstalments.sequence}
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) - ${invoices.amountPaid},
      0
    ),
    ${invoiceInstalments.amount}
  )`;

/**
 * Build the dues set.
 *
 * `scope` must be an INVOICE-level predicate (an issue-date month, a client).
 * A predicate on the instalment would truncate the window partition, so the
 * running total would be computed over a subset of the schedule and every slice
 * after the cut would report the wrong outstanding.
 *
 * Column aliases are deliberately not `due_date`/`invoice_id`: drizzle renders a
 * referenced subquery alias bare rather than qualified, so a name shared with
 * `invoices` becomes an ambiguous-column error the moment anyone joins the two.
 */
export const duesFrom = (organizationId: string, scope?: SQL) => {
  const live = () =>
    and(
      eq(invoices.organizationId, organizationId),
      // Drafts are not owed and voids are not owed. Paid invoices have nothing
      // outstanding by definition.
      inArray(invoices.status, ["sent", "partial"]),
      scope,
    );

  const scheduled = db
    .select({
      invoiceId: sql<string>`${invoiceInstalments.invoiceId}`.as(
        "due_invoice_id",
      ),
      dueOn: sql<string>`${invoiceInstalments.dueDate}`.as("due_on"),
      outstanding: outstandingPerInstalment.as("outstanding"),
    })
    .from(invoiceInstalments)
    .innerJoin(invoices, eq(invoices.id, invoiceInstalments.invoiceId))
    .where(live());

  const unscheduled = db
    .select({
      invoiceId: sql<string>`${invoices.id}`.as("due_invoice_id"),
      dueOn: sql<string>`${invoices.dueDate}`.as("due_on"),
      // greatest(_, 0): balance_due is generated and goes negative on a
      // zero-total invoice that took a payment — deriveStoredStatus only says
      // "paid" when total > 0, so such a row stays 'partial' and stays in this
      // scan. Left unclamped it would net a credit against real receivables.
      outstanding: sql<string>`greatest(${invoices.balanceDue}, 0)`.as(
        "outstanding",
      ),
    })
    .from(invoices)
    .where(
      and(
        live(),
        sql`NOT EXISTS (
          SELECT 1 FROM ${invoiceInstalments}
           WHERE ${invoiceInstalments.invoiceId} = ${invoices.id}
        )`,
      ),
    );

  // unionAll mutates its left argument, so both branches are built fresh here
  // rather than shared with any caller.
  return unionAll(scheduled, unscheduled).as("dues");
};

export type ScheduleSummary = {
  count: number;
  paidCount: number;
  nextDueDate: string | null;
};

/**
 * A one-line schedule summary per invoice, for the list.
 *
 * Keyed on the page's ids and issued as its own query, never joined into the
 * list itself: that join would duplicate every row on the page, inflate the
 * `count()` so pagination lies, and multiply the footer totals.
 *
 * `paidCount` counts the instalments the payments have fully covered, using the
 * same running total as `outstandingPerInstalment` — an instalment is settled
 * once the cumulative amount through it is within half a cent of what has been
 * paid.
 */
export const scheduleSummaries = async (
  organizationId: string,
  invoiceIds: string[],
): Promise<Map<string, ScheduleSummary>> => {
  const summaries = new Map<string, ScheduleSummary>();
  if (invoiceIds.length === 0) return summaries;

  const walked = db
    .select({
      invoiceId: sql<string>`${invoiceInstalments.invoiceId}`.as("s_invoice_id"),
      dueOn: sql<string>`${invoiceInstalments.dueDate}`.as("s_due_on"),
      covered: sql<boolean>`
        sum(${invoiceInstalments.amount}) OVER (
          PARTITION BY ${invoiceInstalments.invoiceId}
          ORDER BY ${invoiceInstalments.dueDate}, ${invoiceInstalments.sequence}
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) <= ${invoices.amountPaid} + 0.005`.as("s_covered"),
    })
    .from(invoiceInstalments)
    .innerJoin(invoices, eq(invoices.id, invoiceInstalments.invoiceId))
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        inArray(invoiceInstalments.invoiceId, invoiceIds),
      ),
    )
    .as("walked");

  const rows = await db
    .select({
      invoiceId: walked.invoiceId,
      count: sql<number>`count(*)::int`,
      paidCount: sql<number>`count(*) FILTER (WHERE ${walked.covered})::int`,
      nextDueDate: sql<string | null>`min(${walked.dueOn}) FILTER (WHERE NOT ${walked.covered})`,
    })
    .from(walked)
    .groupBy(walked.invoiceId);

  for (const row of rows) {
    summaries.set(row.invoiceId, {
      count: row.count,
      paidCount: row.paidCount,
      nextDueDate: row.nextDueDate,
    });
  }
  return summaries;
};

export type DuesAging = {
  current: string;
  d1_15: string;
  d16_30: string;
  d31_plus: string;
  total: string;
  /** Everything past its due date, whatever the bucket. */
  pastDue: string;
  /** Distinct invoices with at least one overdue slice still owing. */
  overdueInvoices: number;
};

/**
 * Aging over slices, with the bucket edges the tab already uses.
 *
 * `today` is passed in rather than resolved here: `firmToday` hits the database
 * uncached, and the report resolves it once and threads one value through every
 * fetcher so the figures cannot straddle a midnight.
 */
export const agingOverDues = async (
  organizationId: string,
  today: string,
  scope?: SQL,
): Promise<DuesAging> => {
  const dues = duesFrom(organizationId, scope);
  const age = sql`(${today}::date - ${dues.dueOn})`;
  const owed = sql`${dues.outstanding}`;

  const [row] = await db
    .select({
      current: sql<string>`coalesce(sum(${owed}) FILTER (WHERE ${age} <= 0), 0)`,
      d1_15: sql<string>`coalesce(sum(${owed}) FILTER (WHERE ${age} BETWEEN 1 AND 15), 0)`,
      d16_30: sql<string>`coalesce(sum(${owed}) FILTER (WHERE ${age} BETWEEN 16 AND 30), 0)`,
      d31_plus: sql<string>`coalesce(sum(${owed}) FILTER (WHERE ${age} > 30), 0)`,
      total: sql<string>`coalesce(sum(${owed}), 0)`,
      pastDue: sql<string>`coalesce(sum(${owed}) FILTER (WHERE ${age} > 0), 0)`,
      // `outstanding > 0` is load-bearing, not defensive. An invoice whose
      // first instalment was paid two months ago still emits a row with a large
      // age and nothing owing; counting it would make the "overdue invoices"
      // tile disagree with the overdue list filter permanently.
      overdueInvoices: sql<number>`count(DISTINCT ${dues.invoiceId})
        FILTER (WHERE ${age} > 0 AND ${owed} > 0)::int`,
    })
    .from(dues);

  return {
    current: row?.current ?? "0",
    d1_15: row?.d1_15 ?? "0",
    d16_30: row?.d16_30 ?? "0",
    d31_plus: row?.d31_plus ?? "0",
    total: row?.total ?? "0",
    pastDue: row?.pastDue ?? "0",
    overdueInvoices: row?.overdueInvoices ?? 0,
  };
};
