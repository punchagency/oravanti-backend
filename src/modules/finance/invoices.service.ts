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
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { timeEntries } from "../../db/schema/time-entries";
import { withTransaction } from "../../db/transaction-context";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
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
import { logFinanceEvent } from "./finance-events.service";
import { allocateInvoiceNumber, currentInvoiceYear } from "./invoice-number";
import { money, num } from "./money";
import {
  countableInvoices,
  effectiveStatusSql,
  firmToday,
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
};

/** Matches case-review's cap and rationale: an export is a page, not a stream. */
export const EXPORT_MAX = 5000;

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * One query, one table, no joins — the payoff for denormalizing the folds onto
 * the invoice header. Drafts and voided invoices are excluded from every
 * figure; a draft is not invoiced revenue and a void is not revenue at all.
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
      overdueCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} IN ('sent','partial') AND ${invoices.dueDate} < ${today})::int`,
      pastDueAmount: sql<string>`coalesce(sum(${invoices.balanceDue}) FILTER (WHERE ${invoices.status} IN ('sent','partial') AND ${invoices.dueDate} < ${today}), 0)`,
      operatingTotal: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trustTotal: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
    })
    .from(invoices)
    .where(and(eq(invoices.organizationId, organizationId), countableInvoices()));

  return {
    invoiceCount: row?.invoiceCount ?? 0,
    totalInvoiced: num(row?.totalInvoiced),
    collected: num(row?.collected),
    collectedCount: row?.collectedCount ?? 0,
    outstanding: num(row?.outstanding),
    outstandingCount: row?.outstandingCount ?? 0,
    overdueCount: row?.overdueCount ?? 0,
    pastDueAmount: num(row?.pastDueAmount),
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
 * The design labels these "1-15 / 16-30 / 30+", which puts day 30 in two
 * buckets. Implemented as `> 30` and surfaced to the UI as "31+ days".
 */
export const getAging = async (
  organizationId: string,
): Promise<AgingBucket[]> => {
  const today = await firmToday(organizationId);
  const age = sql`(${today}::date - ${invoices.dueDate})`;

  const [row] = await db
    .select({
      current: sql<string>`coalesce(sum(${invoices.balanceDue}) FILTER (WHERE ${age} <= 0), 0)`,
      d1_15: sql<string>`coalesce(sum(${invoices.balanceDue}) FILTER (WHERE ${age} BETWEEN 1 AND 15), 0)`,
      d16_30: sql<string>`coalesce(sum(${invoices.balanceDue}) FILTER (WHERE ${age} BETWEEN 16 AND 30), 0)`,
      d31_plus: sql<string>`coalesce(sum(${invoices.balanceDue}) FILTER (WHERE ${age} > 30), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        inArray(invoices.status, ["sent", "partial"]),
      ),
    );

  return [
    { key: "current", label: "Current", amount: num(row?.current) },
    { key: "1_15", label: "1–15 days", amount: num(row?.d1_15) },
    { key: "16_30", label: "16–30 days", amount: num(row?.d16_30) },
    { key: "31_plus", label: "31+ days", amount: num(row?.d31_plus) },
  ];
};

// ── List ─────────────────────────────────────────────────────────────────────

const searchPredicate = (search: string) =>
  or(
    ilike(invoices.invoiceNumber, `%${search}%`),
    ilike(clients.displayName, `%${search}%`),
    ilike(clients.email, `%${search}%`),
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

  const where = and(
    // RLS enforces this too; the explicit predicate is defence in depth and
    // universal in this codebase.
    eq(invoices.organizationId, organizationId),
    // Drafts never appear in the list — the UI has no draft bucket.
    countableInvoices(),
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
      clientName: clients.displayName,
      clientEmail: clients.email,
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
    .innerJoin(clients, eq(clients.id, invoices.clientId))
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
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .where(where);

  const data: InvoiceListRow[] = rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    clientId: r.clientId,
    clientName: r.clientName,
    clientEmail: r.clientEmail,
    caseId: r.caseId,
    caseNumber: r.caseNumber,
    caseTypeLabel: r.caseTypeLabel,
    operatingAmount: num(r.operatingAmount),
    trustAmount: maskTrust(access, num(r.trustAmount)),
    totalAmount: num(r.totalAmount),
    amountPaid: num(r.amountPaid),
    balanceDue: num(r.balanceDue),
    status: r.status as EffectiveInvoiceStatus,
  }));

  return {
    ...buildPaginatedResponse(data, { page, limit, total: Number(total) }),
    restrictions: restrictionsFor(access),
    /** Footer totals for the visible filter, not just the visible page. */
    totals: await listTotals(where, access),
  };
};

const listTotals = async (
  where: ReturnType<typeof and>,
  access: AccountAccess,
) => {
  const [row] = await db
    .select({
      operating: sql<string>`coalesce(sum(${invoices.subtotalOperating}), 0)`,
      trust: sql<string>`coalesce(sum(${invoices.subtotalTrust}), 0)`,
      total: sql<string>`coalesce(sum(${invoices.totalAmount}), 0)`,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(cases, eq(cases.id, invoices.caseId))
    .where(where);

  return {
    operating: num(row?.operating),
    trust: maskTrust(access, num(row?.trust)),
    total: num(row?.total),
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
      clientName: clients.displayName,
      clientEmail: clients.email,
      caseId: invoices.caseId,
      caseNumber: cases.caseNumber,
      caseTypeLabel: practiceAreaCaseTypes.name,
      practiceAreaName: practiceAreas.name,
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
    .innerJoin(clients, eq(clients.id, invoices.clientId))
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
    client: {
      id: row.clientId,
      name: row.clientName,
      email: row.clientEmail,
    },
    matter: row.caseId
      ? { id: row.caseId, reference: row.caseNumber, type: row.caseTypeLabel }
      : null,
    practiceArea: row.practiceAreaName,
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
};

export type CreateInvoiceInput = {
  clientId: string;
  caseId?: string;
  practiceAreaId?: string;
  attorneyId?: string;
  filingType?: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  status: "draft" | "sent";
  lineItems: CreateInvoiceLine[];
  timeEntryIds: string[];
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
    // Approved, unbilled entries only. The unique index on
    // invoice_line_items.time_entry_id is the real backstop against
    // double-billing, but failing here gives a usable message instead of a
    // constraint violation.
    const entries = input.timeEntryIds.length
      ? await db
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
              inArray(timeEntries.id, input.timeEntryIds),
            ),
          )
      : [];

    if (entries.length !== input.timeEntryIds.length) {
      throw new BadRequestError("One or more time entries could not be found");
    }
    for (const e of entries) {
      if (e.status !== "approved") {
        throw new BadRequestError(
          "Only approved time entries can be added to an invoice",
        );
      }
      if (e.invoicedAt) {
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

    const year = await currentInvoiceYear(organizationId);
    const invoiceNumber = await allocateInvoiceNumber(organizationId, year);

    const [invoice] = await db
      .insert(invoices)
      .values({
        organizationId,
        invoiceNumber,
        clientId: input.clientId,
        caseId: input.caseId ?? null,
        practiceAreaId: input.practiceAreaId ?? null,
        attorneyId: input.attorneyId ?? null,
        filingType: input.filingType ?? null,
        status: input.status,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        notes: input.notes ?? null,
        sentAt: input.status === "sent" ? new Date() : null,
        createdById: actorStaffId,
      })
      .returning();

    let sortOrder = 0;
    const lineValues: NewInvoiceLineItem[] = input.lineItems.map((l) => ({
      organizationId,
      invoiceId: invoice!.id,
      description: l.description,
      quantity: money(l.quantity),
      rate: money(l.rate),
      amount: money(l.quantity * l.rate),
      account: l.account,
      sortOrder: sortOrder++,
    }));

    for (const e of entries) {
      const hours = num(e.hoursWorked);
      const rate = num(e.hourlyRate);
      const who = `${e.staffFirstName ?? ""} ${e.staffLastName ?? ""}`.trim();
      lineValues.push({
        organizationId,
        invoiceId: invoice!.id,
        description:
          e.description?.trim() ||
          `Legal services${who ? ` — ${who}` : ""} (${e.entryDate})`,
        quantity: money(hours),
        rate: money(rate),
        // The stored snapshot wins over recomputing hours x rate: it is what
        // was approved, and recomputing could differ by a rounding step.
        amount: money(e.amount == null ? hours * rate : num(e.amount)),
        account: "operating" as const,
        sortOrder: sortOrder++,
        timeEntryId: e.id,
      });
    }

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

    const totals = await recalculateInvoiceTotals(organizationId, invoice!.id);

    await logFinanceEvent({
      organizationId,
      eventType: input.status === "sent" ? "invoice_sent" : "invoice_created",
      title: `${invoiceNumber} — invoice ${input.status === "sent" ? "sent" : "created"}`,
      description: null,
      amount: totals.totalAmount,
      invoiceId: invoice!.id,
      caseId: input.caseId ?? null,
      clientId: input.clientId,
      actorId: actorStaffId,
    });

    // Bridge to the matter timeline when there is one, so the case's own
    // activity trail shows the billing event too.
    if (input.caseId) {
      await logCaseEvent({
        organizationId,
        caseId: input.caseId,
        eventType: "case_invoice_created",
        title: `Invoice ${invoiceNumber} issued`,
        description: `Total ${totals.totalAmount.toFixed(2)}`,
        actorId: actorStaffId,
      });
    }

    return getById(organizationId, invoice!.id, access);
  });
};

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const markSent = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const [existing] = await db
    .select({ status: invoices.status, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) throw new NotFoundError("Invoice not found");
  if (existing.status !== "draft") {
    throw new BadRequestError("Only a draft invoice can be sent");
  }

  await db
    .update(invoices)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    );

  await logFinanceEvent({
    organizationId,
    eventType: "invoice_sent",
    title: `${existing.invoiceNumber} — invoice sent`,
    invoiceId,
    actorId: actorStaffId,
  });

  return getById(organizationId, invoiceId, access);
};

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
  attorneyId?: string;
  filingType?: string;
};

export const update = async (
  organizationId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
  actorStaffId: string | null,
  access: AccountAccess,
) => {
  const [existing] = await db
    .select({ status: invoices.status, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!existing) throw new NotFoundError("Invoice not found");
  if (existing.status === "void") {
    throw new BadRequestError("A voided invoice cannot be edited");
  }

  await db
    .update(invoices)
    .set({
      dueDate: input.dueDate,
      notes: input.notes,
      attorneyId: input.attorneyId,
      filingType: input.filingType,
      updatedAt: new Date(),
    })
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    );

  await logFinanceEvent({
    organizationId,
    eventType: "invoice_updated",
    title: `${existing.invoiceNumber} — invoice updated`,
    invoiceId,
    actorId: actorStaffId,
  });

  return getById(organizationId, invoiceId, access);
};

// ── Unbilled time (feeds the New invoice dialog) ─────────────────────────────

export const getUnbilledTime = async (
  organizationId: string,
  filters: { clientId?: string; caseId?: string },
) => {
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
        sql`${timeEntries.invoicedAt} IS NULL`,
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
      { header: "Client", value: (r) => r.clientName, weight: 1.6 },
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
