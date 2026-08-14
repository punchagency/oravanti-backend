import { and, asc, count, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { invoicePayments } from "../../db/schema/invoice-payments";
import {
  invoiceLineItems,
  invoices,
  type EffectiveInvoiceStatus,
  type NewInvoiceLineItem,
} from "../../db/schema/invoices";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { leads } from "../../db/schema/leads";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { team } from "../../db/schema/auth-schema";
import { teamMembers } from "../../db/schema/team-members";
import { timeEntries } from "../../db/schema/time-entries";
import { withTransaction } from "../../db/transaction-context";
import {
  AuthorizationError,
  BadRequestError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  type PaginationParams,
} from "../../utils/pagination";
import { renderReport, type ReportColumn } from "../../utils/report-export";
import { logCaseEvent } from "../cases/case-events.service";
import {
  maskTrust,
  requireTrustWrite,
  restrictionsFor,
} from "./account-access";
import { sendScheduleUpdate } from "./deliveries.service";
import { agingOverDues, scheduleSummaries } from "./dues";
import { logFinanceEvent } from "./finance-events.service";
import { onClient, onLead, partyEmail, partyName, toParty } from "./party";
import { allocate, type ScheduleRow } from "./instalments";
import {
  assertScheduleBalances,
  clearSchedules,
  listInstalments,
  writeSchedule,
} from "./instalments.service";
import { allocateInvoiceNumber, currentInvoiceYear } from "./invoice-number";
import { money, num } from "./money";
import {
  countableInvoices,
  effectiveStatusSql,
  firmToday,
  listableInvoices,
  statusFilter,
} from "./status";
import { recalculateInvoiceTotals } from "./totals";
import type {
  AccountAccess,
  AccountFilter,
  AgingBucket,
  InvoiceListRow,
  InvoiceStats,
  InvoiceStatusFilter,
} from "./types";

export type ListInvoicesOptions = Partial<PaginationParams> & {
  status?: InvoiceStatusFilter;
  account?: AccountFilter;
  search?: string;
  clientId?: string;
  caseId?: string;
  /** Show drafts alongside the rest. Only honoured when status is "all". */
  includeDrafts?: boolean;
};

/** Matches case-review's cap and rationale: an export is a page, not a stream. */
export const EXPORT_MAX = 5000;

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * One query, one table, no joins — the payoff for denormalizing the folds onto
 * the invoice header. Drafts and voided invoices are excluded from every
 * figure; a draft is not invoiced revenue and a void is not revenue at all.
 *
 * The overdue pair comes from a SECOND query rather than joining the schedule
 * in. On a scheduled invoice the amount past due is the sum of its overdue
 * slices, not its whole balance — but joining `invoice_instalments` here would
 * multiply every one of the ten figures above it by the number of instalments.
 * Two queries, the same reason `fetchTrustReconciliation` uses two subqueries.
 */
export const getStats = async (
  organizationId: string,
  access: AccountAccess,
): Promise<InvoiceStats> => {
  const today = await firmToday(organizationId);

  const [row] = await db
    .select({
      invoiceCount: sql<number>`count(*)::int`,
      totalInvoiced: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
      collected: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
      collectedCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'paid')::int`,
      outstanding: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)`,
      outstandingCount: sql<number>`count(*) FILTER (WHERE ${invoices.balanceDue} > 0)::int`,
      operatingTotal: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trustTotal: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
    })
    .from(invoices)
    .where(and(eq(invoices.organizationId, organizationId), countableInvoices()));

  const overdue = await agingOverDues(organizationId, today);

  return {
    invoiceCount: row?.invoiceCount ?? 0,
    totalInvoiced: num(row?.totalInvoiced),
    collected: num(row?.collected),
    collectedCount: row?.collectedCount ?? 0,
    outstanding: num(row?.outstanding),
    outstandingCount: row?.outstandingCount ?? 0,
    overdueCount: overdue.overdueInvoices,
    pastDueAmount: num(overdue.pastDue),
    operatingTotal: num(row?.operatingTotal),
    // Omitted, not zeroed, when the caller cannot see trust money. The
    // `totalInvoiced` above still includes it, so the visible rows and the
    // headline total continue to reconcile.
    trustTotal: maskTrust(access, num(row?.trustTotal)),
  };
};

/**
 * Aging buckets over outstanding balance.
 *
 * Bucketed per SLICE, not per invoice: an invoice can have $500 forty days late
 * and $500 not due for two months, and those belong in different buckets.
 * `duesFrom` yields one row per unpaid instalment, or a single synthetic row
 * for an invoice with no schedule, so both shapes bucket identically.
 *
 * The design labels these "1-15 / 16-30 / 30+", which puts day 30 in two
 * buckets. Implemented as `> 30` and surfaced to the UI as "31+ days".
 */
export const getAging = async (
  organizationId: string,
): Promise<AgingBucket[]> => {
  const today = await firmToday(organizationId);
  const row = await agingOverDues(organizationId, today);

  return [
    { key: "current", label: "Current", amount: num(row.current) },
    { key: "1_15", label: "1–15 days", amount: num(row.d1_15) },
    { key: "16_30", label: "16–30 days", amount: num(row.d16_30) },
    { key: "31_plus", label: "31+ days", amount: num(row.d31_plus) },
  ];
};

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Both sides of the billed party, or searching for a lead by name would return
 * nothing while their invoice sits in the list.
 */
const searchPredicate = (search: string) =>
  or(
    ilike(invoices.invoiceNumber, `%${search}%`),
    ilike(clients.displayName, `%${search}%`),
    ilike(clients.email, `%${search}%`),
    ilike(leads.firstName, `%${search}%`),
    ilike(leads.lastName, `%${search}%`),
    ilike(leads.email, `%${search}%`),
    ilike(cases.caseNumber, `%${search}%`),
  );

export const list = async (
  organizationId: string,
  access: AccountAccess,
  options: ListInvoicesOptions = {},
) => {
  const { page = 1, limit = 20 } = options;
  const today = await firmToday(organizationId);

  const accountPredicate =
    options.account === "operating"
      ? gt(invoices.subtotalOperating, "0")
      : options.account === "trust"
        ? gt(invoices.subtotalTrust, "0")
        : undefined;

  // Drafts are excluded from every money figure, which is correct — but that
  // would also make the Drafts filter return nothing. Two ways in: asking for
  // the drafts bucket, or asking for them alongside everything else.
  //
  // `includeDrafts` is only honoured on "all": every other bucket names a
  // specific non-draft state, so mixing drafts in would contradict the filter.
  const isAllStatus = !options.status || options.status === "all";
  const showDrafts =
    options.status === "draft" || (isAllStatus && options.includeDrafts === true);

  const where = and(
    // RLS enforces this too; the explicit predicate is defence in depth and
    // universal in this codebase.
    eq(invoices.organizationId, organizationId),
    options.status === "draft" ? undefined : listableInvoices(showDrafts),
    statusFilter(options.status, today),
    accountPredicate,
    options.clientId ? eq(invoices.clientId, options.clientId) : undefined,
    options.caseId ? eq(invoices.caseId, options.caseId) : undefined,
    options.search ? searchPredicate(options.search) : undefined,
  );

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      clientId: invoices.clientId,
      leadId: invoices.leadId,
      partyName,
      partyEmail,
      caseId: invoices.caseId,
      caseNumber: cases.caseNumber,
      caseTypeLabel: practiceAreaCaseTypes.name,
      operatingAmount: invoices.subtotalOperating,
      trustAmount: invoices.subtotalTrust,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      status: effectiveStatusSql(today),
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .where(where)
    .orderBy(desc(invoices.issueDate), desc(invoices.createdAt))
    .limit(limit)
    .offset(getPaginationOffset({ page, limit }));

  const [{ total }] = await db
    .select({ total: count() })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .where(where);

  const schedules = await scheduleSummaries(
    organizationId,
    rows.map((r) => r.id),
  );

  const data: InvoiceListRow[] = rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    party: toParty(r),
    caseId: r.caseId,
    caseNumber: r.caseNumber,
    caseTypeLabel: r.caseTypeLabel,
    operatingAmount: num(r.operatingAmount),
    trustAmount: maskTrust(access, num(r.trustAmount)),
    totalAmount: num(r.totalAmount),
    amountPaid: num(r.amountPaid),
    balanceDue: num(r.balanceDue),
    status: r.status as EffectiveInvoiceStatus,
    schedule: schedules.get(r.id) ?? null,
  }));

  return {
    ...buildPaginatedResponse(data, { page, limit, total: Number(total) }),
    restrictions: restrictionsFor(access),
    /** Footer totals for the visible filter, not just the visible page. */
    totals: await listTotals(where, access),
  };
};

/**
 * Footer totals for the current filter.
 *
 * `countableInvoices()` is re-applied here even though the list's own predicate
 * may admit drafts: a draft that is visible must still not be counted, or the
 * footer would disagree with the tiles above it. `draftCount` is returned
 * alongside so the UI can say how many rows are sitting outside the total
 * rather than leaving the discrepancy unexplained.
 */
const listTotals = async (
  where: ReturnType<typeof and>,
  access: AccountAccess,
) => {
  const [row] = await db
    .select({
      operating: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trust: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
      total: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
      draftCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'draft')::int`,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .where(where);

  const [countable] = await db
    .select({
      operating: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trust: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
      total: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .where(and(where, countableInvoices()));

  return {
    operating: num(countable?.operating),
    trust: maskTrust(access, num(countable?.trust)),
    total: num(countable?.total),
    /** Rows on screen that the totals above deliberately exclude. */
    draftCount: row?.draftCount ?? 0,
  };
};

// ── Detail ───────────────────────────────────────────────────────────────────

export const getById = async (
  organizationId: string,
  invoiceId: string,
  access: AccountAccess,
) => {
  const today = await firmToday(organizationId);

  const [row] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: effectiveStatusSql(today),
      storedStatus: invoices.status,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      notes: invoices.notes,
      filingType: invoices.filingType,
      clientId: invoices.clientId,
      leadId: invoices.leadId,
      partyName,
      partyEmail,
      caseId: invoices.caseId,
      caseNumber: cases.caseNumber,
      caseTypeLabel: practiceAreaCaseTypes.name,
      practiceAreaId: invoices.practiceAreaId,
      practiceAreaName: practiceAreas.name,
      attorneyId: invoices.attorneyId,
      attorneyFirstName: staff.firstName,
      attorneyLastName: staff.lastName,
      operatingAmount: invoices.subtotalOperating,
      trustAmount: invoices.subtotalTrust,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      lastPaymentMethod: invoices.lastPaymentMethod,
      lastPaymentDate: invoices.lastPaymentDate,
      sentAt: invoices.sentAt,
      paidAt: invoices.paidAt,
      createdAt: invoices.createdAt,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .leftJoin(practiceAreas, eq(practiceAreas.id, invoices.practiceAreaId))
    .leftJoin(staff, eq(staff.id, invoices.attorneyId))
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!row) throw new NotFoundError("Invoice not found");

  const lineRows = await db
    .select()
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.organizationId, organizationId),
        eq(invoiceLineItems.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceLineItems.sortOrder), asc(invoiceLineItems.createdAt));

  const paymentRows = await db
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoicePayments.paymentDate));

  const attorneyName = row.attorneyFirstName
    ? `${row.attorneyFirstName} ${row.attorneyLastName ?? ""}`.trim()
    : null;

  // Per-instalment state is derived here rather than in the browser, for the
  // same reason `effectiveStatus` is: the firm's timezone decides what is
  // overdue, and a client-side recomputation would disagree either side of
  // midnight.
  const scheduleRows = await listInstalments(organizationId, invoiceId);
  const instalments = allocate(
    scheduleRows.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      dueDate: s.dueDate,
      amount: num(s.amount),
    })),
    num(row.amountPaid),
  ).map((i) => ({
    ...i,
    state:
      i.state === "paid"
        ? ("paid" as const)
        : i.dueDate < today
          ? ("overdue" as const)
          : i.state,
  }));

  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status as EffectiveInvoiceStatus,
    storedStatus: row.storedStatus,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    notes: row.notes,
    // The design's "filing type" is the case-type label when there is a matter,
    // and the free-text column otherwise.
    filingType: row.caseTypeLabel ?? row.filingType,
    party: toParty(row),
    /**
     * Kept for callers that predate lead billing. Null on an invoice raised
     * against a lead — reading it is how you find code that still assumes a
     * client exists.
     */
    client: row.clientId
      ? { id: row.clientId, name: row.partyName, email: row.partyEmail }
      : null,
    matter: row.caseId
      ? { id: row.caseId, reference: row.caseNumber, type: row.caseTypeLabel }
      : null,
    practiceArea: row.practiceAreaName,
    // The ids sit beside the labels because the edit dialog has to prefill
    // selects, and matching a name back to an option is a guess.
    practiceAreaId: row.practiceAreaId,
    attorneyId: row.attorneyId,
    attorney: attorneyName,
    lineItems: lineRows
      // Trust lines are not merely blanked — they are withheld entirely, so a
      // caller without access cannot infer the amounts from the arithmetic.
      .filter((l) => l.account === "operating" || restrictionsFor(access).trust !== "no_access")
      .map((l) => ({
        id: l.id,
        description: l.description,
        quantity: num(l.quantity),
        rate: num(l.rate),
        amount: num(l.amount),
        account: l.account,
        timeEntryId: l.timeEntryId,
        // Returned so editing a draft round-trips provenance instead of
        // silently orphaning every line the picker composed.
        presetId: l.presetId,
      })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      amount: num(p.amount),
      amountOperating: num(p.amountOperating),
      amountTrust: maskTrust(access, num(p.amountTrust)),
      paymentDate: p.paymentDate,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      createdAt: p.createdAt,
    })),
    totals: {
      operating: num(row.operatingAmount),
      trust: maskTrust(access, num(row.trustAmount)),
      total: num(row.totalAmount),
      amountPaid: num(row.amountPaid),
      balanceDue: num(row.balanceDue),
    },
    instalments,
    lastPaymentMethod: row.lastPaymentMethod,
    lastPaymentDate: row.lastPaymentDate,
    sentAt: row.sentAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    restrictions: restrictionsFor(access),
  };
};

// ── Create ───────────────────────────────────────────────────────────────────

export type CreateInvoiceLine = {
  description: string;
  quantity: number;
  rate: number;
  account: "operating" | "trust_iolta";
  /**
   * The catalog preset this line was composed from, when it was. Provenance
   * only: the three fields above are what gets billed, and none of them is
   * ever read back off the preset. See `line-presets.service.ts`.
   */
  presetId?: string;
};

/**
 * Load the time entries an invoice is about to bill, refusing the ones that
 * cannot legally be billed.
 *
 * The unique index on `invoice_line_items.time_entry_id` is the real backstop
 * against double-billing; failing here just turns a constraint violation into a
 * message someone can act on.
 *
 * `alreadyHeld` names the entries this same invoice holds today — on an edit
 * they are legitimately stamped `invoicedAt`, so the "already invoiced" rule
 * would otherwise reject an invoice for keeping its own lines.
 */
const loadBillableEntries = async (
  organizationId: string,
  entryIds: string[],
  alreadyHeld: ReadonlySet<string> = new Set(),
) => {
  if (entryIds.length === 0) return [];

  const entries = await db
    .select({
      id: timeEntries.id,
      hoursWorked: timeEntries.hoursWorked,
      hourlyRate: timeEntries.hourlyRate,
      amount: timeEntries.amount,
      description: timeEntries.description,
      entryDate: timeEntries.entryDate,
      status: timeEntries.status,
      invoicedAt: timeEntries.invoicedAt,
      billable: timeEntries.billable,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
    })
    .from(timeEntries)
    .leftJoin(staff, eq(staff.id, timeEntries.staffId))
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        inArray(timeEntries.id, entryIds),
      ),
    );

  if (entries.length !== entryIds.length) {
    throw new BadRequestError("One or more time entries could not be found");
  }

  for (const e of entries) {
    if (e.status !== "approved") {
      throw new BadRequestError(
        "Only approved time entries can be added to an invoice",
      );
    }
    if (e.invoicedAt && !alreadyHeld.has(e.id)) {
      throw new BadRequestError(
        "One or more time entries have already been invoiced",
      );
    }
    if (!e.billable) {
      throw new BadRequestError(
        "Non-billable time entries cannot be added to an invoice",
      );
    }
    if (e.hourlyRate == null) {
      throw new BadRequestError(
        "One or more time entries have no billing rate — set a rate for the staff member first",
      );
    }
  }

  return entries;
};

type BillableEntry = Awaited<ReturnType<typeof loadBillableEntries>>[number];

/** Build the manual and time-entry lines for an invoice, in that order. */
const buildLineValues = (
  organizationId: string,
  invoiceId: string,
  lineItems: CreateInvoiceLine[],
  entries: BillableEntry[],
): NewInvoiceLineItem[] => {
  let sortOrder = 0;

  const values: NewInvoiceLineItem[] = lineItems.map((l) => ({
    organizationId,
    invoiceId,
    description: l.description,
    quantity: money(l.quantity),
    rate: money(l.rate),
    amount: money(l.quantity * l.rate),
    account: l.account,
    presetId: l.presetId ?? null,
    sortOrder: sortOrder++,
  }));

  for (const e of entries) {
    const hours = num(e.hoursWorked);
    const rate = num(e.hourlyRate);
    const who = `${e.staffFirstName ?? ""} ${e.staffLastName ?? ""}`.trim();
    values.push({
      organizationId,
      invoiceId,
      description:
        e.description?.trim() ||
        `Legal services${who ? ` — ${who}` : ""} (${e.entryDate})`,
      quantity: money(hours),
      rate: money(rate),
      // The stored snapshot wins over recomputing hours x rate: it is what was
      // approved, and recomputing could differ by a rounding step.
      amount: money(e.amount == null ? hours * rate : num(e.amount)),
      account: "operating" as const,
      sortOrder: sortOrder++,
      timeEntryId: e.id,
    });
  }

  return values;
};

export type CreateInvoiceInput = {
  /** Exactly one of these. A lead is billed during intake, a client after. */
  clientId?: string;
  leadId?: string;
  caseId?: string;
  practiceAreaId?: string;
  attorneyId?: string;
  filingType?: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  status: "draft";
  lineItems: CreateInvoiceLine[];
  timeEntryIds: string[];
  /** Optional payment schedule; must sum to the resulting invoice total. */
  instalments?: ScheduleRow[];
};

export const create = async (
  organizationId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  input: CreateInvoiceInput,
) => {
  if (input.lineItems.some((l) => l.account === "trust_iolta")) {
    requireTrustWrite(access);
  }

  return withTransaction(db, async () => {
    const entries = await loadBillableEntries(
      organizationId,
      input.timeEntryIds,
    );

    const year = await currentInvoiceYear(organizationId);
    const invoiceNumber = await allocateInvoiceNumber(organizationId, year);

    const [invoice] = await db
      .insert(invoices)
      .values({
        organizationId,
        invoiceNumber,
        clientId: input.clientId ?? null,
        leadId: input.leadId ?? null,
        caseId: input.caseId ?? null,
        practiceAreaId: input.practiceAreaId ?? null,
        attorneyId: input.attorneyId ?? null,
        filingType: input.filingType ?? null,
        status: input.status,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        notes: input.notes ?? null,
        // `sentAt` is set by a successful delivery and nothing else.
        createdById: actorStaffId,
      })
      .returning();

    const lineValues = buildLineValues(
      organizationId,
      invoice!.id,
      input.lineItems,
      entries,
    );

    if (lineValues.length === 0) {
      throw new BadRequestError("An invoice needs at least one line item");
    }

    await db.insert(invoiceLineItems).values(lineValues);

    if (entries.length) {
      await db
        .update(timeEntries)
        .set({ invoicedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(timeEntries.organizationId, organizationId),
            inArray(
              timeEntries.id,
              entries.map((e) => e.id),
            ),
          ),
        );
    }

    if (input.instalments?.length) {
      await writeSchedule(organizationId, invoice!.id, input.instalments);
    }

    const totals = await recalculateInvoiceTotals(organizationId, invoice!.id);
    await assertScheduleBalances(organizationId, invoice!.id, totals.totalAmount);

    await logFinanceEvent({
      organizationId,
      eventType: "invoice_created",
      title: `${invoiceNumber} — draft created`,
      description: null,
      amount: totals.totalAmount,
      invoiceId: invoice!.id,
      caseId: input.caseId ?? null,
      clientId: input.clientId ?? null,
      actorId: actorStaffId,
    });

    // Bridge to the matter timeline when there is one, so the case's own
    // activity trail shows the billing event too.
    if (input.caseId) {
      await logCaseEvent({
        organizationId,
        caseId: input.caseId,
        eventType: "case_invoice_created",
        title: `Invoice ${invoiceNumber} drafted`,
        description: `Total ${totals.totalAmount.toFixed(2)}`,
        actorId: actorStaffId,
      });
    }

    return getById(organizationId, invoice!.id, access);
  });
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type ExtendDueDateInput = {
  dueDate: string;
  reason?: string;
};

/**
 * Give a client longer to pay.
 *
 * Only on a live, unsettled invoice — stored `sent` or `partial`. Note that
 * covers the *overdue* case too, since overdue is derived from `dueBy < today`
 * rather than stored, and an invoice already past its date is the main thing
 * anyone wants to extend.
 *
 * Deliberately a separate operation from `update`, which also accepts a
 * `dueDate`, for three reasons:
 *
 *   1. **Forward only.** `update` would happily move a due date backwards and
 *      make an invoice overdue on the spot. An extension that can shorten is
 *      not an extension.
 *   2. It records *why*, and records the date it moved from — an audit trail
 *      that says only "invoice updated" cannot answer "who gave them another
 *      fortnight".
 *   3. `update`'s content edits are draft-only, so its live-invoice surface is
 *      a handful of header fields nobody has a dedicated screen for. This does.
 *
 * **On a scheduled invoice it moves the next unpaid instalment**, not the header
 * date. The header is pinned to the FINAL instalment by `writeSchedule`, so
 * writing to it directly would leave the invoice claiming a date its own
 * schedule contradicts — but refusing outright was wrong too. A client who has
 * missed instalment 1 of 4 needs longer on instalment 1; the invoice as a whole
 * is not what is late, and rewriting the entire plan to move one date is a poor
 * answer to "can we have another fortnight".
 *
 * That is also what `overdue` already means for these invoices: `dueBy` is
 * `coalesce(next_due_date, due_date)`, so a scheduled invoice goes overdue on
 * its next unpaid slice, never on its final one.
 *
 * The move is refused when it would push the instalment past the one after it —
 * `writeSchedule` sorts and renumbers, so allowing it would silently reorder the
 * plan. That case is a genuine reschedule and says so. Extending the LAST
 * instalment has nothing to collide with, and carries the header date with it.
 */
export const extendDueDate = async (
  organizationId: string,
  invoiceId: string,
  input: ExtendDueDateInput,
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const [existing] = await db
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      dueDate: invoices.dueDate,
      amountPaid: invoices.amountPaid,
      caseId: invoices.caseId,
      clientId: invoices.clientId,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) throw new NotFoundError("Invoice not found");

  // Named per state rather than one "cannot extend" — each of these is a
  // different thing to do next.
  if (existing.status === "draft") {
    throw new BadRequestError(
      "This invoice is still a draft. Change its due date by editing it.",
    );
  }
  if (existing.status === "void") {
    throw new BadRequestError("A voided invoice has no due date to extend");
  }
  if (existing.status === "paid") {
    throw new BadRequestError("This invoice is settled — there is nothing owing");
  }

  const schedule = await listInstalments(organizationId, invoiceId);

  // What "the due date" means for this invoice, and what moving it entails.
  // Resolved before any validation so both shapes report against the date the
  // caller is actually looking at.
  const plan = schedule.length
    ? (() => {
        const allocated = allocate(
          schedule.map((row) => ({ ...row, amount: num(row.amount) })),
          num(existing.amountPaid),
        );
        const target = allocated.find((row) => row.outstanding > 0);
        const after = target
          ? allocated.find((row) => row.dueDate > target.dueDate)
          : undefined;
        return { kind: "scheduled" as const, target, after };
      })()
    : { kind: "single" as const, target: undefined, after: undefined };

  const currentDue =
    plan.kind === "scheduled" ? plan.target?.dueDate : existing.dueDate;

  if (plan.kind === "scheduled" && !plan.target) {
    // Every slice is covered but the invoice is not marked paid — a state the
    // payment path should have resolved. Refusing beats guessing which row to
    // move.
    throw new BadRequestError(
      "Every instalment on this invoice is already covered",
    );
  }

  if (!currentDue || input.dueDate <= currentDue) {
    throw new BadRequestError(
      `The new due date must be later than the current one (${currentDue})`,
    );
  }

  // Strictly before the next instalment. Reordering the plan is a reschedule,
  // not an extension: writeSchedule sorts by date and renumbers, so letting one
  // past would silently renumber the instalments under the client.
  //
  // `>=`, not `>`. Landing exactly ON the next instalment's date leaves two
  // slices due the same day with no ordering between them — the sort's
  // tiebreak decides which becomes 1 and which becomes 2, and the client sees
  // two rows on one date where they agreed to a sequence.
  if (plan.after && input.dueDate >= plan.after.dueDate) {
    throw new BadRequestError(
      `This instalment must fall before the next one (due ${plan.after.dueDate}). Revise the payment plan instead.`,
    );
  }

  return withTransaction(db, async () => {
    if (plan.kind === "scheduled") {
      // Rewritten through writeSchedule rather than a targeted UPDATE so the
      // header date stays pinned to the final instalment and `sequence` stays
      // in due-date order — the two invariants dues.ts relies on.
      //
      // Deliberately NOT setSchedule: that announces a revised plan to the
      // client by email, and this is the same act as extending an unscheduled
      // invoice, which does not. When notifications land, both should gain one
      // together.
      await writeSchedule(
        organizationId,
        invoiceId,
        schedule.map((row) => ({
          dueDate: row.id === plan.target!.id ? input.dueDate : row.dueDate,
          amount: num(row.amount),
        })),
      );
    } else {
      await db
        .update(invoices)
        .set({ dueDate: input.dueDate, updatedAt: new Date() })
        .where(
          and(
            eq(invoices.organizationId, organizationId),
            eq(invoices.id, invoiceId),
          ),
        );
    }

    // `next_due_date` is a fold and recalculateInvoiceTotals is its only writer.
    // On a scheduled invoice this is what actually moves the overdue predicate,
    // since `dueBy` reads coalesce(next_due_date, due_date).
    const totals = await recalculateInvoiceTotals(organizationId, invoiceId);
    await assertScheduleBalances(organizationId, invoiceId, totals.totalAmount);

    await logFinanceEvent({
      organizationId,
      eventType: "invoice_updated",
      title:
        plan.kind === "scheduled"
          ? `${existing.invoiceNumber} — instalment ${plan.target!.sequence} extended to ${input.dueDate}`
          : `${existing.invoiceNumber} — due date extended to ${input.dueDate}`,
      // The date it moved FROM lives here and nowhere else: the row now holds
      // the new value, so without this the trail cannot say what changed.
      description: [
        `Was due ${currentDue}`,
        input.reason?.trim() ? `Reason: ${input.reason.trim()}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: null,
      invoiceId,
      caseId: existing.caseId,
      clientId: existing.clientId,
      actorId: actorStaffId,
    });

    return getById(organizationId, invoiceId, access);
  });
};

/**
 * Cancel an invoice.
 *
 * Voiding is how a sent invoice is corrected — the document the client holds is
 * withdrawn and a fresh one issued, rather than rewritten under them.
 *
 * **Refused once any money has been recorded against it.** `countableInvoices()`
 * excludes voids from every tile and report, but the `invoice_payments` rows
 * survive: voiding a paid invoice would drop the firm's `collected` figure by
 * money it actually received and still holds, leaving the ledger and the
 * reports permanently disagreeing with no trace of why. There is no reversing
 * entry to undo it with either — `invoice_payments_amount_positive` is a check
 * constraint, so a negative payment cannot be written.
 *
 * The proper remedy for "paid, but the invoice was wrong" is a credit note,
 * which this module does not model yet. Until it does, refusing is the honest
 * answer: the firm settles it out of band rather than through a number that
 * silently stops adding up.
 */
export const voidInvoice = async (
  organizationId: string,
  invoiceId: string,
  reason: string | undefined,
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const [existing] = await db
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) throw new NotFoundError("Invoice not found");
  if (existing.status === "void") {
    throw new BadRequestError("Invoice is already void");
  }
  // Checked on `amount_paid`, not on `status === 'paid'`: a partly paid invoice
  // carries the same problem for a smaller number, and status alone would let
  // it through.
  if (num(existing.amountPaid) > 0) {
    throw new BadRequestError(
      "This invoice has payments recorded against it and cannot be voided. Voiding it would remove money the firm has received from every report while the payments themselves remain on the ledger.",
    );
  }

  return withTransaction(db, async () => {
    await db
      .update(invoices)
      .set({ status: "void", voidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.id, invoiceId),
        ),
      );

    // Release the time entries so the work can be re-billed on a correct
    // invoice. The line items stay — the voided invoice remains readable.
    const lines = await db
      .select({ timeEntryId: invoiceLineItems.timeEntryId })
      .from(invoiceLineItems)
      .where(
        and(
          eq(invoiceLineItems.organizationId, organizationId),
          eq(invoiceLineItems.invoiceId, invoiceId),
        ),
      );
    const entryIds = lines
      .map((l) => l.timeEntryId)
      .filter((id): id is string => id != null);
    if (entryIds.length) {
      await db
        .update(timeEntries)
        .set({ invoicedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(timeEntries.organizationId, organizationId),
            inArray(timeEntries.id, entryIds),
          ),
        );
      await db
        .update(invoiceLineItems)
        .set({ timeEntryId: null })
        .where(
          and(
            eq(invoiceLineItems.organizationId, organizationId),
            eq(invoiceLineItems.invoiceId, invoiceId),
          ),
        );
    }

    // A voided invoice owes nothing, so its schedule is meaningless. Dropping
    // it also keeps `duesFrom` honest: it emits instalment rows for any invoice
    // that has a schedule, and the status filter is the only thing that would
    // otherwise be holding those slices out of the aging report.
    await clearSchedules(organizationId, [invoiceId]);

    await logFinanceEvent({
      organizationId,
      eventType: "invoice_voided",
      title: `${existing.invoiceNumber} — invoice voided`,
      description: reason ?? null,
      amount: num(existing.totalAmount),
      invoiceId,
      actorId: actorStaffId,
    });

    return getById(organizationId, invoiceId, access);
  });
};

export type UpdateInvoiceInput = {
  dueDate?: string;
  notes?: string;
  attorneyId?: string | null;
  filingType?: string;
  /** Draft-only, below. */
  issueDate?: string;
  caseId?: string | null;
  practiceAreaId?: string | null;
  lineItems?: CreateInvoiceLine[];
  timeEntryIds?: string[];
  /**
   * Replaces the whole schedule. Unlike the rest of the content set this is
   * allowed on a sent invoice — see the note in `update()`.
   */
  instalments?: ScheduleRow[];
};

/**
 * Edit an invoice.
 *
 * Header fields (due date, notes, attorney, filing type) apply to any live
 * invoice. Anything that changes what the invoice *says it charges* — lines,
 * time entries, the matter, the issue date — is refused on anything but a
 * draft: once a client has been sent an invoice it is a legal statement of what
 * they owe, and the correction for that is a void plus a reissue, not a silent
 * rewrite of a document someone already has a copy of.
 */
export const update = async (
  organizationId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const editsContent =
    input.lineItems !== undefined ||
    input.timeEntryIds !== undefined ||
    input.issueDate !== undefined ||
    input.caseId !== undefined ||
    input.practiceAreaId !== undefined ||
    input.instalments !== undefined;

  const [existing] = await db
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      issueDate: invoices.issueDate,
      dueDate: invoices.dueDate,
      caseId: invoices.caseId,
      practiceAreaId: invoices.practiceAreaId,
      subtotalTrust: invoices.subtotalTrust,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) throw new NotFoundError("Invoice not found");
  if (existing.status === "void") {
    throw new BadRequestError("A voided invoice cannot be edited");
  }

  const scheduled =
    (await listInstalments(organizationId, invoiceId)).length > 0;

  // A schedule's rows have to keep summing to the total, so a line edit that
  // moves the total has to arrive with the schedule that matches it. Refusing
  // outright ("delete the schedule first") would make nudging a rate by $50 a
  // three-step dance; the dialog sends both together.
  if (
    scheduled &&
    input.instalments === undefined &&
    (input.lineItems !== undefined || input.timeEntryIds !== undefined)
  ) {
    throw new BadRequestError(
      "This invoice has a payment schedule. Send the updated schedule with the line changes, or remove the schedule first.",
    );
  }

  // The header due date belongs to the schedule once one exists — writeSchedule
  // pins it to the final instalment. Accepting a bare due-date change here would
  // let the invoice claim a date its own schedule contradicts.
  if (scheduled && input.dueDate !== undefined && input.instalments === undefined) {
    throw new BadRequestError(
      "This invoice's due date follows its payment schedule. Revise the schedule instead.",
    );
  }

  if (editsContent) {
    // A schedule may be revised after sending — plans get renegotiated, and
    // that is the point of offering one. Only the rest of the content set is
    // draft-only.
    const scheduleOnly =
      input.instalments !== undefined &&
      input.lineItems === undefined &&
      input.timeEntryIds === undefined &&
      input.issueDate === undefined &&
      input.caseId === undefined &&
      input.practiceAreaId === undefined;

    if (!scheduleOnly && existing.status !== "draft") {
      throw new BadRequestError(
        "Only a draft invoice can be edited. Void this one and issue a corrected invoice instead.",
      );
    }

    // getById withholds trust lines from a caller without access, so the client
    // cannot have sent them back — replacing the line set would delete them
    // without the person doing it ever seeing they existed.
    if (
      restrictionsFor(access).trust === "no_access" &&
      num(existing.subtotalTrust) > 0
    ) {
      throw new AuthorizationError(
        "This draft has trust (IOLTA) lines you do not have access to, so it cannot be edited here",
      );
    }
    if (input.lineItems?.some((l) => l.account === "trust_iolta")) {
      requireTrustWrite(access);
    }

    const issueDate = input.issueDate ?? existing.issueDate;
    const dueDate = input.dueDate ?? existing.dueDate;
    if (dueDate < issueDate) {
      throw new BadRequestError("Due date cannot precede the issue date");
    }

    // Same rule as create: without one or the other, revenue-by-practice-area
    // silently undercounts the invoice.
    const caseId = input.caseId !== undefined ? input.caseId : existing.caseId;
    const practiceAreaId =
      input.practiceAreaId !== undefined
        ? input.practiceAreaId
        : existing.practiceAreaId;
    if (caseId == null && practiceAreaId == null) {
      throw new BadRequestError(
        "A practice area is required when the invoice has no matter",
      );
    }
  }

  const result = await withTransaction(db, async () => {
    await db
      .update(invoices)
      .set({
        dueDate: input.dueDate,
        notes: input.notes,
        attorneyId: input.attorneyId,
        filingType: input.filingType,
        issueDate: input.issueDate,
        caseId: input.caseId,
        practiceAreaId: input.practiceAreaId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.id, invoiceId),
        ),
      );

    if (input.lineItems !== undefined && input.timeEntryIds !== undefined) {
      await replaceInvoiceLines(
        organizationId,
        invoiceId,
        input.lineItems,
        input.timeEntryIds,
      );
    }

    // After the lines, so the header due date it pins survives the write above.
    if (input.instalments !== undefined) {
      await writeSchedule(organizationId, invoiceId, input.instalments);
    }

    // Also on a bare due-date change: `next_due_date` is a fold this function is
    // the sole writer of, and skipping it there would leave the invoice
    // overdue-or-not according to a date nobody can see.
    const totals =
      editsContent || input.dueDate !== undefined
        ? await recalculateInvoiceTotals(organizationId, invoiceId)
        : null;

    if (totals) {
      await assertScheduleBalances(organizationId, invoiceId, totals.totalAmount);
    }

    await logFinanceEvent({
      organizationId,
      eventType:
        input.instalments !== undefined
          ? scheduled
            ? "invoice_schedule_revised"
            : "invoice_schedule_set"
          : "invoice_updated",
      title: `${existing.invoiceNumber} — ${
        input.instalments !== undefined
          ? `payment schedule ${scheduled ? "revised" : "set"}`
          : editsContent
            ? "draft edited"
            : "invoice updated"
      }`,
      amount: totals?.totalAmount ?? null,
      invoiceId,
      actorId: actorStaffId,
    });

    return getById(organizationId, invoiceId, access);
  });

  // Same rule as the dedicated schedule endpoint: if this edit changed a plan
  // on an invoice the client already holds, tell them. AFTER the commit, since
  // an email cannot be rolled back. A draft is a no-op inside — the schedule
  // ships with the invoice when it is first sent.
  if (input.instalments !== undefined) {
    await sendScheduleUpdate(organizationId, invoiceId, actorStaffId, access, {
      revised: scheduled,
    });
  }

  return result;
};

/**
 * Swap a draft's line set for a new one, and reconcile which time entries it
 * holds.
 *
 * Replacing wholesale rather than diffing the lines is safe precisely because
 * this is draft-only: nothing references a line item (payments hang off the
 * invoice), and a draft cannot have payments. What does need care is
 * `time_entries.invoicedAt` — an entry dropped from the draft has to be
 * released, or the work becomes permanently unbillable.
 *
 * Must be called inside a transaction.
 */
const replaceInvoiceLines = async (
  organizationId: string,
  invoiceId: string,
  lineItems: CreateInvoiceLine[],
  timeEntryIds: string[],
) => {
  const currentLines = await db
    .select({ timeEntryId: invoiceLineItems.timeEntryId })
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.organizationId, organizationId),
        eq(invoiceLineItems.invoiceId, invoiceId),
      ),
    );

  const held = new Set(
    currentLines
      .map((l) => l.timeEntryId)
      .filter((id): id is string => id != null),
  );
  const wanted = new Set(timeEntryIds);
  const released = [...held].filter((id) => !wanted.has(id));
  const claimed = timeEntryIds.filter((id) => !held.has(id));

  const entries = await loadBillableEntries(organizationId, timeEntryIds, held);

  const lineValues = buildLineValues(
    organizationId,
    invoiceId,
    lineItems,
    entries,
  );
  if (lineValues.length === 0) {
    throw new BadRequestError("An invoice needs at least one line item");
  }

  // Delete before insert: the unique index on time_entry_id would otherwise
  // reject re-inserting a line for an entry the draft already holds.
  await db
    .delete(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.organizationId, organizationId),
        eq(invoiceLineItems.invoiceId, invoiceId),
      ),
    );
  await db.insert(invoiceLineItems).values(lineValues);

  if (released.length) {
    await db
      .update(timeEntries)
      .set({ invoicedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          inArray(timeEntries.id, released),
        ),
      );
  }
  if (claimed.length) {
    await db
      .update(timeEntries)
      .set({ invoicedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          inArray(timeEntries.id, claimed),
        ),
      );
  }
};

// ── Unbilled time (feeds the New invoice dialog) ─────────────────────────────

export const getUnbilledTime = async (
  organizationId: string,
  filters: { clientId?: string; caseId?: string; forInvoiceId?: string },
) => {
  // "Unbilled, plus whatever this draft already holds." Attaching an entry
  // stamps `invoicedAt`, which is exactly what makes it stop being unbilled —
  // so without this an edit could only ever remove time, never keep it.
  const heldByInvoice = filters.forInvoiceId
    ? db
        .select({ id: invoiceLineItems.timeEntryId })
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.organizationId, organizationId),
            eq(invoiceLineItems.invoiceId, filters.forInvoiceId),
            sql`${invoiceLineItems.timeEntryId} IS NOT NULL`,
          ),
        )
    : null;

  const rows = await db
    .select({
      id: timeEntries.id,
      entryDate: timeEntries.entryDate,
      hoursWorked: timeEntries.hoursWorked,
      hourlyRate: timeEntries.hourlyRate,
      amount: timeEntries.amount,
      description: timeEntries.description,
      caseId: timeEntries.caseId,
      caseNumber: cases.caseNumber,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
    })
    .from(timeEntries)
    .leftJoin(staff, eq(staff.id, timeEntries.staffId))
    .leftJoin(cases, eq(cases.id, timeEntries.caseId))
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.status, "approved"),
        eq(timeEntries.billable, true),
        heldByInvoice
          ? or(
              sql`${timeEntries.invoicedAt} IS NULL`,
              inArray(timeEntries.id, heldByInvoice),
            )
          : sql`${timeEntries.invoicedAt} IS NULL`,
        filters.caseId ? eq(timeEntries.caseId, filters.caseId) : undefined,
        filters.clientId ? eq(cases.clientId, filters.clientId) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.entryDate));

  return rows.map((r) => ({
    id: r.id,
    entryDate: r.entryDate,
    hours: num(r.hoursWorked),
    rate: r.hourlyRate == null ? null : num(r.hourlyRate),
    amount: r.amount == null ? null : num(r.amount),
    description: r.description,
    caseId: r.caseId,
    caseNumber: r.caseNumber,
    staffName: `${r.staffFirstName ?? ""} ${r.staffLastName ?? ""}`.trim() || null,
    rateUnset: r.hourlyRate == null,
  }));
};

// ── Case defaults (prefills the New invoice dialog) ──────────────────────────

/**
 * Who should be billed as the attorney on an invoice for this matter.
 *
 * A case is assigned to a *team*, not a person, so there is no attorney to read
 * off it directly. The resolution order, and why:
 *
 *   1. **The team lead, when they are an attorney.** This is the "if there are
 *      several attorneys, pick the lead" rule — the lead is the person who owns
 *      the matter.
 *   2. **The team's only attorney.** With exactly one there is nothing to
 *      disambiguate, and it holds even when the team lead is a paralegal.
 *   3. **The team lead, whatever their role.** A team with no attorney at all
 *      still has someone answerable for it.
 *   4. Nothing. Better an empty select than a confident wrong name on a bill.
 *
 * `source` and `attorneyCount` come back so the dialog can say *why* a name was
 * filled in — a prefill nobody can account for is one nobody will correct.
 *
 * The matter's `practiceAreaId` and `caseTypeId` ride along because the line
 * preset picker needs them to scope its catalog, and the dialog already calls
 * this the moment a matter is chosen. Returning them here costs nothing and
 * saves a second round trip.
 */
export const getCaseDefaults = async (
  organizationId: string,
  caseId: string,
) => {
  const [row] = await db
    .select({
      teamId: cases.assignedTeamId,
      practiceAreaId: cases.practiceAreaId,
      caseTypeId: cases.caseTypeId,
    })
    .from(cases)
    .where(and(eq(cases.organizationId, organizationId), eq(cases.id, caseId)))
    .limit(1);

  if (!row) throw new NotFoundError("Matter not found");

  const empty = {
    caseId,
    attorneyId: null as string | null,
    attorneyName: null as string | null,
    source: null as "team_lead" | "sole_attorney" | null,
    attorneyCount: 0,
    practiceAreaId: row.practiceAreaId,
    caseTypeId: row.caseTypeId,
  };

  if (!row.teamId) return empty;

  // team.leadId is text holding a staff uuid — there is no FK on it, hence the
  // cast rather than a normal join condition.
  const [leadRow] = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      role: staff.role,
    })
    .from(team)
    .innerJoin(
      staff,
      and(
        sql`${staff.id}::text = ${team.leadId}`,
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
      ),
    )
    .where(and(eq(team.id, row.teamId), eq(team.organizationId, organizationId)))
    .limit(1);

  const attorneys = await db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(teamMembers)
    .innerJoin(staff, eq(staff.id, teamMembers.staffId))
    .where(
      and(
        eq(teamMembers.teamId, row.teamId),
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        eq(staff.role, "attorney"),
      ),
    );

  const named = (p: { firstName: string; lastName: string }) =>
    `${p.firstName} ${p.lastName}`.trim();

  // Every branch spreads `empty` so the matter's scope rides along whichever
  // attorney rule fired — the picker needs it on all four paths, and listing
  // the fields per branch is how one of them would eventually be forgotten.
  if (leadRow?.role === "attorney") {
    return {
      ...empty,
      attorneyId: leadRow.id,
      attorneyName: named(leadRow),
      source: "team_lead" as const,
      attorneyCount: attorneys.length,
    };
  }

  if (attorneys.length === 1) {
    return {
      ...empty,
      attorneyId: attorneys[0]!.id,
      attorneyName: named(attorneys[0]!),
      source: "sole_attorney" as const,
      attorneyCount: 1,
    };
  }

  if (leadRow) {
    return {
      ...empty,
      attorneyId: leadRow.id,
      attorneyName: named(leadRow),
      source: "team_lead" as const,
      attorneyCount: attorneys.length,
    };
  }

  return { ...empty, attorneyCount: attorneys.length };
};

// ── Export ───────────────────────────────────────────────────────────────────

export const exportInvoices = async (
  organizationId: string,
  access: AccountAccess,
  options: ListInvoicesOptions,
  format: "csv" | "pdf",
) => {
  const page = await list(organizationId, access, {
    ...options,
    page: 1,
    limit: EXPORT_MAX,
  });

  type Row = InvoiceListRow;
  const columns: ReportColumn<Row>[] = [
      { header: "Invoice #", value: (r) => r.invoiceNumber },
      { header: "Billed to", value: (r) => r.party.name, weight: 1.6 },
      { header: "Matter", value: (r) => r.caseNumber ?? "" },
      { header: "Operating", value: (r) => r.operatingAmount.toFixed(2) },
      // Dropped from the spec entirely — not emitted blank — when the caller
      // has no trust access. One spec drives CSV and PDF, so both stay correct.
      ...(restrictionsFor(access).trust === "no_access"
        ? []
        : [
            {
              header: "Trust",
              value: (r: Row) => (r.trustAmount ?? 0).toFixed(2),
            },
          ]),
      { header: "Total", value: (r) => r.totalAmount.toFixed(2) },
      { header: "Paid", value: (r) => r.amountPaid.toFixed(2) },
      { header: "Balance", value: (r) => r.balanceDue.toFixed(2) },
      { header: "Status", value: (r) => r.status },
      { header: "Issued", value: (r) => r.issueDate },
    { header: "Due", value: (r) => r.dueDate },
  ];

  const report = await renderReport(format, page.data, columns, {
    title: "Invoices",
    subtitle: `${page.data.length} invoice(s) · exported ${new Date().toISOString().slice(0, 10)}`,
  });

  return {
    filename: `invoices.${report.extension}`,
    mime: report.mime,
    body: report.body,
  };
};
