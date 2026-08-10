import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices } from "../../db/schema/invoices";
import { practiceAreas } from "../../db/schema/practice-areas";
import { renderReport, type ReportColumn } from "../../utils/report-export";
import { dayjs } from "../../utils/date";
import { canReadTrust, restrictionsFor } from "./account-access";
import { agingOverDues } from "./dues";
import { num, toMoney } from "./money";
import { countableInvoices, dueBy, firmToday } from "./status";
import type { AccountAccess } from "./types";

/**
 * The Reports tab is ONE endpoint returning ONE payload.
 *
 * The UI renders a single screen, so six round trips would be six chances to
 * show mutually inconsistent numbers — a collection rate computed a moment
 * before a payment lands, next to a total computed a moment after.
 *
 * Every figure excludes drafts and voids, so the tiles, the practice-area table
 * and the collection rate all share one denominator.
 */

const monthBounds = (month: string) => {
  const start = dayjs(`${month}-01`);
  return {
    from: start.format("YYYY-MM-DD"),
    to: start.endOf("month").format("YYYY-MM-DD"),
  };
};

const inMonth = (from: string, to: string) =>
  and(gte(invoices.issueDate, from), lte(invoices.issueDate, to));

export const getMonthlyReport = async (
  organizationId: string,
  access: AccountAccess,
  month?: string,
) => {
  const today = await firmToday(organizationId);
  const targetMonth = month ?? today.slice(0, 7);
  const { from, to } = monthBounds(targetMonth);

  const scope = and(
    eq(invoices.organizationId, organizationId),
    countableInvoices(),
    inMonth(from, to),
  );
  // The same month window without the org/status predicates, which `duesFrom`
  // applies itself. Passing the full `scope` would repeat them harmlessly but
  // reads as though the dues query were unscoped without it.
  const monthScope = inMonth(from, to);

  const [
    summary,
    collectionStatus,
    byPracticeArea,
    aging,
    trustReconciliation,
    trustInvoices,
  ] = await Promise.all([
    fetchSummary(organizationId, scope, monthScope, today),
    fetchCollectionStatus(scope, today),
    fetchByPracticeArea(scope),
    fetchAging(organizationId, today),
    canReadTrust(access) ? fetchTrustReconciliation(organizationId, from, to) : null,
    canReadTrust(access) ? fetchTrustInvoices(organizationId, from, to) : null,
  ]);

  const operating = summary.operatingTotal;
  const trust = summary.trustTotal;
  const splitTotal = operating + trust;

  return {
    month: targetMonth,
    summary: {
      totalRevenue: summary.totalInvoiced,
      collected: summary.collected,
      outstanding: summary.outstanding,
      overdue: summary.overdueAmount,
      invoiceCount: summary.invoiceCount,
      // collected / invoiced, with void and draft excluded from both.
      collectionRate:
        summary.totalInvoiced > 0
          ? Math.round((summary.collected / summary.totalInvoiced) * 100)
          : 0,
    },
    accountSplit: {
      operating,
      // Withheld rather than zeroed — see account-access.ts.
      trust: canReadTrust(access) ? trust : null,
      operatingPercent:
        splitTotal > 0 ? Math.round((operating / splitTotal) * 100) : 0,
      trustPercent: canReadTrust(access)
        ? splitTotal > 0
          ? Math.round((trust / splitTotal) * 100)
          : 0
        : null,
    },
    collectionStatus,
    byPracticeArea,
    aging,
    trustReconciliation: trustReconciliation
      ? { ...trustReconciliation, invoices: trustInvoices ?? [] }
      : null,
    restrictions: restrictionsFor(access),
  };
};

const fetchSummary = async (
  organizationId: string,
  scope: ReturnType<typeof and>,
  monthScope: ReturnType<typeof and>,
  today: string,
) => {
  const [row] = await db
    .select({
      invoiceCount: sql<number>`count(*)::int`,
      totalInvoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
      // Cohort, not cash: what has been collected against invoices ISSUED in
      // this month. That is what makes `collectionRate` a coherent ratio —
      // both sides share one population. Cash received during the month is a
      // different figure and is deliberately not what this reports.
      collected: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
      outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`,
      operatingTotal: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trustTotal: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
    })
    .from(invoices)
    .where(scope);

  // Overdue is per SLICE — on a scheduled invoice only the instalments that
  // have actually fallen due are late. It gets its own query for two reasons:
  // joining the schedule into the SELECT above would multiply all six figures,
  // and the month scope has to be carried across explicitly or this silently
  // becomes an all-time figure that exceeds `outstanding`.
  const overdue = await agingOverDues(organizationId, today, monthScope);

  return {
    invoiceCount: row?.invoiceCount ?? 0,
    totalInvoiced: num(row?.totalInvoiced),
    collected: num(row?.collected),
    outstanding: num(row?.outstanding),
    operatingTotal: num(row?.operatingTotal),
    trustTotal: num(row?.trustTotal),
    overdueAmount: num(overdue.pastDue),
  };
};

/** Invoice counts and amounts per effective status bucket. */
const fetchCollectionStatus = async (
  scope: ReturnType<typeof and>,
  today: string,
) => {
  const [row] = await db
    .select({
      paidCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'paid')::int`,
      paidAmount: sql<string>`coalesce(sum(${invoices.totalAmount}) FILTER (WHERE ${invoices.status} = 'paid'), 0)`,
      overdueCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} IN ('sent','partial') AND ${dueBy} < ${today})::int`,
      overdueAmount: sql<string>`coalesce(sum(${invoices.totalAmount}) FILTER (WHERE ${invoices.status} IN ('sent','partial') AND ${dueBy} < ${today}), 0)`,
      partialCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'partial' AND ${dueBy} >= ${today})::int`,
      partialAmount: sql<string>`coalesce(sum(${invoices.totalAmount}) FILTER (WHERE ${invoices.status} = 'partial' AND ${dueBy} >= ${today}), 0)`,
      unpaidCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'sent' AND ${invoices.amountPaid} = 0 AND ${dueBy} >= ${today})::int`,
      unpaidAmount: sql<string>`coalesce(sum(${invoices.totalAmount}) FILTER (WHERE ${invoices.status} = 'sent' AND ${invoices.amountPaid} = 0 AND ${dueBy} >= ${today}), 0)`,
    })
    .from(invoices)
    .where(scope);

  // Every bucket reports the INVOICE TOTAL, not the outstanding balance, so
  // the four amounts sum to `summary.totalRevenue` — which is how the design's
  // panel reads (its four figures add up to "Total revenue invoiced" exactly).
  // Mixing totals for `paid` with balances for the rest made the breakdown add
  // up to neither revenue nor outstanding.
  //
  // Same precedence as the list filter: overdue outranks partial, so each
  // invoice appears in exactly one bucket.
  //
  // This is INVOICE granularity, deliberately, and it is why
  // `collectionStatus.overdue.amount` does not equal `summary.overdue`. A
  // scheduled invoice can be part overdue and part not-yet-due, and splitting
  // one `total_amount` across two buckets would break the sum above — the
  // invariant this panel exists to hold. The scope labels on the payload say
  // which figure is which.
  return [
    { status: "paid", count: row?.paidCount ?? 0, amount: num(row?.paidAmount) },
    {
      status: "overdue",
      count: row?.overdueCount ?? 0,
      amount: num(row?.overdueAmount),
    },
    {
      status: "partial",
      count: row?.partialCount ?? 0,
      amount: num(row?.partialAmount),
    },
    {
      status: "unpaid",
      count: row?.unpaidCount ?? 0,
      amount: num(row?.unpaidAmount),
    },
  ];
};

/**
 * The coalesce is what lets a case-less invoice classify from its own
 * practiceAreaId. Rows with neither are surfaced as "Unassigned" rather than
 * dropped, so these rows reconcile with the summary total.
 */
const fetchByPracticeArea = async (scope: ReturnType<typeof and>) => {
  const rows = await db
    .select({
      practiceAreaId: sql<string | null>`coalesce(${invoices.practiceAreaId}, ${cases.practiceAreaId})`,
      name: practiceAreas.name,
      invoiceCount: sql<number>`count(*)::int`,
      invoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
      collected: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
      outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`,
    })
    .from(invoices)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .leftJoin(
      practiceAreas,
      sql`${practiceAreas.id} = coalesce(${invoices.practiceAreaId}, ${cases.practiceAreaId})`,
    )
    .where(scope)
    .groupBy(
      sql`coalesce(${invoices.practiceAreaId}, ${cases.practiceAreaId})`,
      practiceAreas.name,
    )
    .orderBy(sql`sum(${invoices.totalAmount}) DESC`);

  return rows.map((r) => {
    const invoiced = num(r.invoiced);
    const collected = num(r.collected);
    return {
      practiceAreaId: r.practiceAreaId,
      name: r.name ?? "Unassigned",
      invoiceCount: r.invoiceCount,
      invoiced,
      collected,
      outstanding: num(r.outstanding),
      collectionRate: invoiced > 0 ? Math.round((collected / invoiced) * 100) : 0,
    };
  });
};

/**
 * Aging is deliberately NOT month-scoped: what is owed is owed regardless of
 * which month it was invoiced in, and a month-filtered aging table would show
 * an artificially clean receivables position.
 */
const fetchAging = async (organizationId: string, today: string) => {
  // Per slice: an invoice with one instalment forty days late and another not
  // due for two months contributes to two different buckets.
  const row = await agingOverDues(organizationId, today);

  return {
    // Explicitly all-time. Aging answers "what is owed", which does not depend
    // on which month an invoice happened to be raised in — so this total will
    // legitimately exceed `summary.outstanding` whenever an older invoice is
    // still unpaid. Flagged here so the UI can say so rather than looking like
    // it contradicts the month figure.
    scope: "all_time" as const,
    total: num(row.total),
    buckets: [
      { key: "current", label: "Current (not yet due)", amount: num(row.current) },
      { key: "1_15", label: "1–15 days overdue", amount: num(row.d1_15) },
      { key: "16_30", label: "16–30 days overdue", amount: num(row.d16_30) },
      // "> 30", labelled 31+: the design's "30+" would double-count day 30.
      { key: "31_plus", label: "31+ days overdue", amount: num(row.d31_plus) },
    ],
  };
};

/**
 * Two scalar subqueries, NOT a join.
 *
 * Joining invoices to the 1:N invoice_payments would multiply `subtotal_trust`
 * once per payment — the classic fan-out that silently inflates the figure the
 * moment an invoice takes a second payment.
 */
const fetchTrustReconciliation = async (
  organizationId: string,
  from: string,
  to: string,
) => {
  const [invoiced] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
      count: sql<number>`count(*) FILTER (WHERE ${invoices.subtotalTrust} > 0)::int`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        countableInvoices(),
        inMonth(from, to),
      ),
    );

  const [collected] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoicePayments.amountTrust}), 0)`,
    })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        countableInvoices(),
        inMonth(from, to),
      ),
    );

  const filingFeesInvoiced = num(invoiced?.total);
  const filingFeesCollected = num(collected?.total);

  return {
    filingFeesInvoiced,
    filingFeesCollected,
    /**
     * NOTE: this is "invoiced but not yet collected", not a true trust
     * balance. Nothing in the system records a disbursement OUT of trust
     * (paying a filing fee to USCIS), so the figure can only grow. Real IOLTA
     * reconciliation needs a trust_disbursements table — flagged as a
     * follow-up, and surfaced honestly here so the UI can label it correctly.
     */
    heldInTrustPending: toMoney(filingFeesInvoiced - filingFeesCollected),
    trustInvoiceCount: invoiced?.count ?? 0,
    disbursementsTracked: false,
  };
};

const fetchTrustInvoices = async (
  organizationId: string,
  from: string,
  to: string,
) => {
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      clientName: clients.displayName,
      trustAmount: invoices.subtotalTrust,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        countableInvoices(),
        inMonth(from, to),
        gt(invoices.subtotalTrust, "0"),
      ),
    )
    .orderBy(clients.displayName);

  return rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    clientName: r.clientName,
    trustAmount: num(r.trustAmount),
    paid: r.status === "paid",
  }));
};

// ── Export ───────────────────────────────────────────────────────────────────

export const exportReport = async (
  organizationId: string,
  access: AccountAccess,
  month: string | undefined,
  format: "csv" | "pdf",
) => {
  const report = await getMonthlyReport(organizationId, access, month);

  type Row = (typeof report.byPracticeArea)[number];
  const columns: ReportColumn<Row>[] = [
    { header: "Practice area", value: (r) => r.name, weight: 1.6 },
    { header: "Invoices", value: (r) => r.invoiceCount, weight: 0.6 },
    { header: "Invoiced", value: (r) => r.invoiced.toFixed(2) },
    { header: "Collected", value: (r) => r.collected.toFixed(2) },
    { header: "Outstanding", value: (r) => r.outstanding.toFixed(2) },
    { header: "Rate", value: (r) => `${r.collectionRate}%`, weight: 0.5 },
  ];

  const rendered = await renderReport(format, report.byPracticeArea, columns, {
    title: `Financial report — ${report.month}`,
    subtitle: `Invoiced ${report.summary.totalRevenue.toFixed(2)} · collected ${report.summary.collected.toFixed(2)} · ${report.summary.collectionRate}% collection rate`,
  });

  return {
    filename: `finance-report-${report.month}.${rendered.extension}`,
    mime: rendered.mime,
    body: rendered.body,
  };
};
