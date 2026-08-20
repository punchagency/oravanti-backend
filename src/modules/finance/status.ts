import { SQL, and, eq, inArray, sql } from "drizzle-orm";
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
 * The date an invoice is next owed money on.
 *
 * `next_due_date` is the earliest instalment not yet covered by `amount_paid`,
 * and NULL when the invoice has no payment schedule — which is most of them, and
 * every row that predates schedules. So every predicate reads through this
 * coalesce rather than either column directly: a bare `next_due_date < today` is
 * false on NULL, and so is `next_due_date >= today`, which would drop
 * unscheduled invoices out of the overdue bucket AND the partial and unpaid
 * buckets simultaneously — visible in the list, findable by no filter.
 *
 * coalesce over two columns is IMMUTABLE, so `invoices_org_status_due_idx` is
 * declared on this same expression and the predicates below stay sargable. That
 * is the only reason `next_due_date` is stored rather than derived.
 */
export const dueBy = sql`coalesce(${invoices.nextDueDate}, ${invoices.dueDate})`;

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
    WHEN ${invoices.status} = 'void'     THEN 'void'
    WHEN ${invoices.status} = 'draft'    THEN 'draft'
    WHEN ${invoices.status} = 'paid'     THEN 'paid'
    -- ABOVE the due-date test on purpose. A refunded invoice has no balance to
    -- be late with, and every one of them is past its due date eventually, so a
    -- branch below this line would be unreachable exactly when it matters and
    -- the invoice would surface in collections.
    WHEN ${invoices.status} = 'refunded' THEN 'refunded'
    WHEN ${dueBy} < ${today}             THEN 'overdue'
    WHEN ${invoices.status} = 'partial'  THEN 'partial'
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
    case "refunded":
      return eq(invoices.status, "refunded");
    case "overdue":
      return and(
        inArray(invoices.status, ["sent", "partial"]),
        sql`${dueBy} < ${today}`,
      );
    case "partial":
      return and(eq(invoices.status, "partial"), sql`${dueBy} >= ${today}`);
    case "unpaid":
      return and(
        eq(invoices.status, "sent"),
        eq(invoices.amountPaid, "0"),
        sql`${dueBy} >= ${today}`,
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
 * rate's denominator. Refunded invoices are out for the same reason as void:
 * the money came back, so counting it would report revenue the firm does not
 * have. Stated once here so the numbers cannot disagree.
 */
export const countableInvoices = () =>
  inArray(invoices.status, ["sent", "partial", "paid"]);

/**
 * What the LIST may show, which is not the same question as what counts as
 * money. Drafts can be surfaced here on request; `countableInvoices` stays the
 * only thing the tiles, reports and footer totals are built from, so a draft
 * can never become revenue by being made visible.
 *
 * Stated as its own set rather than reaching for `countableInvoices()`, which
 * is how `refunded` came to be invisible: it was added to the status enum and
 * deliberately kept OUT of the money predicate, and the list silently inherited
 * that exclusion. A refunded invoice is precisely the kind a firm needs to find
 * — it is the record of money that went back — so the two questions have to be
 * asked separately now that their answers differ.
 *
 * `void` remains absent, unchanged: a voided invoice has never been listable
 * and there is no filter offering it. Worth revisiting, but not here.
 */
const LISTABLE_STATUSES = ["sent", "partial", "paid", "refunded"] as const;

export const listableInvoices = (includeDrafts: boolean) =>
  inArray(
    invoices.status,
    includeDrafts ? ["draft", ...LISTABLE_STATUSES] : [...LISTABLE_STATUSES],
  );

/**
 * The overdue predicate at INVOICE granularity — "this invoice has something
 * past due".
 *
 * Note what it is not: the amount overdue. On a scheduled invoice only some
 * slices are past due, so anything summing money reaches for `agingOverDues` in
 * dues.ts instead. This is for counting invoices and for bucketing an invoice
 * as a whole.
 */
export const overdueCondition = (today: string) =>
  and(inArray(invoices.status, ["sent", "partial"]), sql`${dueBy} < ${today}`);
