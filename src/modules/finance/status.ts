import { SQL, and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { invoices } from "../../db/schema/invoices";
import { dayjs } from "../../utils/date";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import type { InvoiceStatusFilter } from "./types";

/**
 * Invoice status is stored as draft | sent | partial | paid | void.
 * `unpaid` and `overdue` are DERIVED here and never stored.
 *
 *   - paid/partial are facts about payments, so they must change atomically
 *     with the payment insert (see totals.ts).
 *   - overdue is a pure function of due_date < today. Storing it would need a
 *     nightly job to stay correct, would be wrong for the hours between
 *     midnight and that job, and would fight the payment path for ownership of
 *     the column. A stored `overdue` is a cache with no invalidation story.
 *
 * This module is the single place that decides what bucket an invoice is in,
 * so the list, the filters, the stats tiles and the reports can never disagree.
 */

/**
 * "Today" in the FIRM's timezone, not the database server's.
 *
 * Never use CURRENT_DATE in the SQL: it reads the server's timezone, and it is
 * also non-immutable, which would stop the expression participating in an
 * index. The value is resolved once per request and bound as a parameter.
 */
export const firmToday = async (organizationId: string): Promise<string> => {
  const tz = await getFirmTimezone(organizationId);
  return dayjs().tz(tz).format("YYYY-MM-DD");
};

/**
 * The single bucket a row belongs to, for the SELECT list.
 *
 * Note the ordering: `overdue` outranks `partial`. The UI filter is
 * single-select, so every invoice must land in exactly one bucket, and a
 * part-paid invoice past its due date is what a collections screen needs to
 * surface. Consequence the frontend must live with: the `partial` and
 * `overdue` counts do not sum to `unpaid`.
 */
export const effectiveStatusSql = (today: string) => sql<string>`
  CASE
    WHEN ${invoices.status} = 'void'    THEN 'void'
    WHEN ${invoices.status} = 'draft'   THEN 'draft'
    WHEN ${invoices.status} = 'paid'    THEN 'paid'
    WHEN ${invoices.dueDate} < ${today} THEN 'overdue'
    WHEN ${invoices.status} = 'partial' THEN 'partial'
    ELSE 'unpaid'
  END`;

/**
 * Explicit predicates for the WHERE clause.
 *
 * Deliberately NOT `WHERE (CASE … END) = $1`: that expression is not sargable
 * and would force a full scan. These hit invoices_org_status_due_idx.
 */
export const statusFilter = (
  value: InvoiceStatusFilter | undefined,
  today: string,
): SQL | undefined => {
  switch (value) {
    // Drafts are excluded from `countableInvoices`, so they never reach a money
    // figure. This filter is the only way to see them — which is what makes
    // them sendable rather than invisible.
    case "draft":
      return eq(invoices.status, "draft");
    case "paid":
      return eq(invoices.status, "paid");
    case "overdue":
      return and(
        inArray(invoices.status, ["sent", "partial"]),
        lt(invoices.dueDate, today),
      );
    case "partial":
      return and(
        eq(invoices.status, "partial"),
        gte(invoices.dueDate, today),
      );
    case "unpaid":
      return and(
        eq(invoices.status, "sent"),
        eq(invoices.amountPaid, "0"),
        gte(invoices.dueDate, today),
      );
    default:
      return undefined; // "all"
  }
};

/**
 * The predicate every money aggregate starts from.
 *
 * Drafts are not invoiced revenue and voided invoices are not revenue at all,
 * so both are excluded from every tile, every report figure and the collection
 * rate's denominator. Stated once here so the numbers cannot disagree.
 */
export const countableInvoices = () =>
  inArray(invoices.status, ["sent", "partial", "paid"]);

/** The overdue predicate, shared by the stats tile and the aging buckets. */
export const overdueCondition = (today: string) =>
  and(inArray(invoices.status, ["sent", "partial"]), lt(invoices.dueDate, today));
