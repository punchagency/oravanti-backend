import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { staff } from "../../db/schema/staff";
import { timeEntries } from "../../db/schema/time-entries";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  type PaginationParams,
} from "../../utils/pagination";
import { renderReport, type ReportColumn } from "../../utils/report-export";
import { computeAmount, resolveBillingRate } from "./billing-rates.service";
import { logFinanceEvent } from "./finance-events.service";
import { EXPORT_MAX } from "./invoices.service";
import { money, num } from "./money";
import type { TimeBillingStats, TimeEntryRow } from "./types";

export type TimeEntryStatusFilter = "all" | "pending" | "approved";

export type ListTimeEntriesOptions = Partial<PaginationParams> & {
  status?: TimeEntryStatusFilter;
  staffId?: string;
  caseId?: string;
  from?: string;
  to?: string;
};

const periodPredicate = (from?: string, to?: string) =>
  and(
    from ? gte(timeEntries.entryDate, from) : undefined,
    to ? lte(timeEntries.entryDate, to) : undefined,
  );

/**
 * Earnings are the stored `amount` — never `hours x staff.hourlyRate`.
 *
 * The snapshot is what was actually approved and, once invoiced, what a client
 * was actually billed. Recomputing from the live rate would silently restate
 * every historical figure the moment someone gets a raise.
 */
export const getStats = async (
  organizationId: string,
  period: { from?: string; to?: string } = {},
): Promise<TimeBillingStats> => {
  const [row] = await db
    .select({
      hoursLogged: sql<string>`coalesce(sum(${timeEntries.hoursWorked}), 0)`,
      billableHours: sql<string>`coalesce(sum(${timeEntries.hoursWorked}) FILTER (WHERE ${timeEntries.billable}), 0)`,
      totalEarnings: sql<string>`coalesce(sum(${timeEntries.amount}) FILTER (WHERE ${timeEntries.billable} AND ${timeEntries.status} = 'approved'), 0)`,
      approvedCount: sql<number>`count(*) FILTER (WHERE ${timeEntries.status} = 'approved')::int`,
      pendingCount: sql<number>`count(*) FILTER (WHERE ${timeEntries.status} = 'pending')::int`,
      rateUnsetCount: sql<number>`count(*) FILTER (WHERE ${timeEntries.billable} AND ${timeEntries.hourlyRate} IS NULL)::int`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        periodPredicate(period.from, period.to),
      ),
    );

  const hoursLogged = num(row?.hoursLogged);
  const billableHours = num(row?.billableHours);

  return {
    hoursLogged,
    billableHours,
    totalEarnings: num(row?.totalEarnings),
    approvedCount: row?.approvedCount ?? 0,
    pendingCount: row?.pendingCount ?? 0,
    billableRate:
      hoursLogged > 0 ? Math.round((billableHours / hoursLogged) * 100) : 0,
    rateUnsetCount: row?.rateUnsetCount ?? 0,
  };
};

export const list = async (
  organizationId: string,
  options: ListTimeEntriesOptions = {},
) => {
  const { page = 1, limit = 20 } = options;

  const statusPredicate =
    options.status === "pending"
      ? eq(timeEntries.status, "pending")
      : options.status === "approved"
        ? eq(timeEntries.status, "approved")
        : // "all" still excludes rejected: a rejected entry is not work the firm
          // is claiming, and showing it among approved time invites mis-billing.
          inArray(timeEntries.status, ["pending", "approved"]);

  const where = and(
    eq(timeEntries.organizationId, organizationId),
    statusPredicate,
    options.staffId ? eq(timeEntries.staffId, options.staffId) : undefined,
    options.caseId ? eq(timeEntries.caseId, options.caseId) : undefined,
    periodPredicate(options.from, options.to),
  );

  const rows = await db
    .select({
      id: timeEntries.id,
      staffId: timeEntries.staffId,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
      staffRole: staff.role,
      caseId: timeEntries.caseId,
      caseNumber: cases.caseNumber,
      entryDate: timeEntries.entryDate,
      hoursWorked: timeEntries.hoursWorked,
      billable: timeEntries.billable,
      hourlyRate: timeEntries.hourlyRate,
      amount: timeEntries.amount,
      status: timeEntries.status,
      description: timeEntries.description,
      invoicedAt: timeEntries.invoicedAt,
    })
    .from(timeEntries)
    .leftJoin(staff, eq(staff.id, timeEntries.staffId))
    .leftJoin(cases, eq(cases.id, timeEntries.caseId))
    .where(where)
    .orderBy(desc(timeEntries.entryDate), desc(timeEntries.createdAt))
    .limit(limit)
    .offset(getPaginationOffset({ page, limit }));

  const [{ total }] = await db
    .select({ total: count() })
    .from(timeEntries)
    .leftJoin(staff, eq(staff.id, timeEntries.staffId))
    .leftJoin(cases, eq(cases.id, timeEntries.caseId))
    .where(where);

  const data: TimeEntryRow[] = rows.map((r) => ({
    id: r.id,
    staffId: r.staffId,
    staffName:
      `${r.staffFirstName ?? ""} ${r.staffLastName ?? ""}`.trim() || "—",
    staffRole: r.staffRole,
    caseId: r.caseId,
    caseNumber: r.caseNumber,
    entryDate: r.entryDate,
    hoursWorked: num(r.hoursWorked),
    billable: r.billable,
    amount: r.amount == null ? null : num(r.amount),
    status: r.status,
    description: r.description,
    rateUnset: r.billable && r.hourlyRate == null,
    invoicedAt: r.invoicedAt,
  }));

  const [totals] = await db
    .select({
      hours: sql<string>`coalesce(sum(${timeEntries.hoursWorked}) FILTER (WHERE ${timeEntries.billable}), 0)`,
      amount: sql<string>`coalesce(sum(${timeEntries.amount}), 0)`,
    })
    .from(timeEntries)
    .leftJoin(staff, eq(staff.id, timeEntries.staffId))
    .leftJoin(cases, eq(cases.id, timeEntries.caseId))
    .where(where);

  return {
    ...buildPaginatedResponse(data, { page, limit, total: Number(total) }),
    totals: { hours: num(totals?.hours), amount: num(totals?.amount) },
  };
};

/**
 * One GROUP BY, not a per-staff loop.
 *
 * Deliberately not the shape used by revenue-analytics.service.ts, which maps
 * over the staff list with an await inside — that is a genuine N+1.
 */
export const getEarningsByStaff = async (
  organizationId: string,
  period: { from?: string; to?: string } = {},
) => {
  const rows = await db
    .select({
      staffId: timeEntries.staffId,
      firstName: staff.firstName,
      lastName: staff.lastName,
      hours: sql<string>`coalesce(sum(${timeEntries.hoursWorked}), 0)`,
      entryCount: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${timeEntries.amount}), 0)`,
    })
    .from(timeEntries)
    .innerJoin(staff, eq(staff.id, timeEntries.staffId))
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.status, "approved"),
        eq(timeEntries.billable, true),
        periodPredicate(period.from, period.to),
      ),
    )
    .groupBy(timeEntries.staffId, staff.firstName, staff.lastName)
    .orderBy(sql`sum(${timeEntries.amount}) DESC NULLS LAST`);

  return rows.map((r) => ({
    staffId: r.staffId,
    staffName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || "—",
    hours: num(r.hours),
    entryCount: r.entryCount,
    amount: num(r.amount),
  }));
};

/**
 * Top matters by hours.
 *
 * `time_entries.caseId` is nullable, so non-matter time (admin, business
 * development) has no matter to group under. It is returned separately as
 * `unattributedHours` rather than silently dropped, so these figures reconcile
 * with the hours-logged tile.
 */
export const getTopMatters = async (
  organizationId: string,
  period: { from?: string; to?: string } = {},
  limit = 5,
) => {
  const rows = await db
    .select({
      caseId: cases.id,
      caseNumber: cases.caseNumber,
      clientName: clients.displayName,
      hours: sql<string>`coalesce(sum(${timeEntries.hoursWorked}), 0)`,
      amount: sql<string>`coalesce(sum(${timeEntries.amount}), 0)`,
    })
    .from(timeEntries)
    .innerJoin(cases, eq(cases.id, timeEntries.caseId))
    .innerJoin(clients, eq(clients.id, cases.clientId))
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        periodPredicate(period.from, period.to),
      ),
    )
    .groupBy(cases.id, cases.caseNumber, clients.displayName)
    .orderBy(sql`sum(${timeEntries.hoursWorked}) DESC`)
    .limit(limit);

  const [unattributed] = await db
    .select({
      hours: sql<string>`coalesce(sum(${timeEntries.hoursWorked}), 0)`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        sql`${timeEntries.caseId} IS NULL`,
        periodPredicate(period.from, period.to),
      ),
    );

  return {
    matters: rows.map((r) => ({
      caseId: r.caseId,
      caseNumber: r.caseNumber,
      clientName: r.clientName,
      hours: num(r.hours),
      amount: num(r.amount),
    })),
    unattributedHours: num(unattributed?.hours),
  };
};

// ── Mutations ────────────────────────────────────────────────────────────────

export type CreateTimeEntryInput = {
  staffId?: string;
  caseId?: string;
  entryDate: string;
  hoursWorked: number;
  description?: string;
  billable: boolean;
};

export const create = async (
  organizationId: string,
  actorStaffId: string | null,
  canApprove: boolean,
  input: CreateTimeEntryInput,
) => {
  const targetStaffId = input.staffId ?? actorStaffId;
  if (!targetStaffId) {
    throw new BadRequestError("No staff member to log this time against");
  }

  // Someone holding only `log_time` records their own hours. Logging on
  // another person's behalf is a supervisory act.
  if (targetStaffId !== actorStaffId && !canApprove) {
    throw new BadRequestError("You can only log time for yourself");
  }

  // Resolved as at the ENTRY's date, not today, so back-dated work is valued
  // at the rate that applied when it was done.
  const resolved = await resolveBillingRate(
    organizationId,
    targetStaffId,
    input.entryDate,
  );
  const amount = input.billable
    ? computeAmount(input.hoursWorked, resolved.rate)
    : null;

  const [entry] = await db
    .insert(timeEntries)
    .values({
      organizationId,
      staffId: targetStaffId,
      caseId: input.caseId ?? null,
      entryDate: input.entryDate,
      hoursWorked: input.hoursWorked.toFixed(2),
      description: input.description ?? null,
      billable: input.billable,
      status: "pending",
      hourlyRate: resolved.rate == null ? null : money(resolved.rate),
      amount: amount == null ? null : money(amount),
    })
    .returning();

  await logFinanceEvent({
    organizationId,
    eventType: "time_entry_logged",
    title: `${input.hoursWorked}h logged`,
    description: input.description ?? null,
    amount,
    timeEntryId: entry!.id,
    caseId: input.caseId ?? null,
    actorId: actorStaffId,
  });

  return entry!;
};

export const approve = async (
  organizationId: string,
  entryId: string,
  actorStaffId: string | null,
) => {
  const [entry] = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .limit(1);

  if (!entry) throw new NotFoundError("Time entry not found");
  if (entry.status === "approved") {
    throw new BadRequestError("This entry is already approved");
  }
  if (actorStaffId && entry.staffId === actorStaffId) {
    throw new BadRequestError("A time entry cannot be approved by its author");
  }

  // Re-resolve on approval — but only while still pending, so a corrected or
  // back-dated rate row flows into work the firm has not yet committed to.
  // Once invoiced the snapshot is frozen; that path never reaches here.
  const resolved = await resolveBillingRate(
    organizationId,
    entry.staffId,
    entry.entryDate,
  );
  const amount = entry.billable
    ? computeAmount(num(entry.hoursWorked), resolved.rate)
    : null;

  const [updated] = await db
    .update(timeEntries)
    .set({
      status: "approved",
      approvedById: actorStaffId,
      approvedAt: new Date(),
      rejectionReason: null,
      hourlyRate: resolved.rate == null ? null : money(resolved.rate),
      amount: amount == null ? null : money(amount),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .returning();

  await logFinanceEvent({
    organizationId,
    eventType: "time_entry_approved",
    title: `${num(entry.hoursWorked)}h approved`,
    amount,
    timeEntryId: entryId,
    caseId: entry.caseId,
    actorId: actorStaffId,
  });

  return updated!;
};

export const reject = async (
  organizationId: string,
  entryId: string,
  reason: string,
  actorStaffId: string | null,
) => {
  const [entry] = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .limit(1);

  if (!entry) throw new NotFoundError("Time entry not found");
  if (entry.invoicedAt) {
    throw new BadRequestError(
      "This entry has already been invoiced and cannot be rejected",
    );
  }

  const [updated] = await db
    .update(timeEntries)
    .set({
      status: "rejected",
      rejectionReason: reason,
      approvedById: actorStaffId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .returning();

  await logFinanceEvent({
    organizationId,
    eventType: "time_entry_rejected",
    title: `${num(entry.hoursWorked)}h rejected`,
    description: reason,
    timeEntryId: entryId,
    caseId: entry.caseId,
    actorId: actorStaffId,
  });

  return updated!;
};

export type UpdateTimeEntryInput = {
  caseId?: string;
  entryDate?: string;
  hoursWorked?: number;
  description?: string;
  billable?: boolean;
};

export const update = async (
  organizationId: string,
  entryId: string,
  input: UpdateTimeEntryInput,
) => {
  const [entry] = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .limit(1);

  if (!entry) throw new NotFoundError("Time entry not found");
  if (entry.invoicedAt) {
    throw new BadRequestError(
      "This entry has been invoiced; edit the invoice instead",
    );
  }

  const entryDate = input.entryDate ?? entry.entryDate;
  const hours = input.hoursWorked ?? num(entry.hoursWorked);
  const billable = input.billable ?? entry.billable;

  // The date or the hours may have moved, so re-resolve rather than scaling the
  // old amount — the new date could fall the other side of a rate change.
  const resolved = await resolveBillingRate(
    organizationId,
    entry.staffId,
    entryDate,
  );
  const amount = billable ? computeAmount(hours, resolved.rate) : null;

  const [updated] = await db
    .update(timeEntries)
    .set({
      caseId: input.caseId ?? entry.caseId,
      entryDate,
      hoursWorked: hours.toFixed(2),
      description: input.description ?? entry.description,
      billable,
      hourlyRate: resolved.rate == null ? null : money(resolved.rate),
      amount: amount == null ? null : money(amount),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(timeEntries.organizationId, organizationId),
        eq(timeEntries.id, entryId),
      ),
    )
    .returning();

  return updated!;
};

// ── Export ───────────────────────────────────────────────────────────────────

export const exportTimeEntries = async (
  organizationId: string,
  options: ListTimeEntriesOptions,
  format: "csv" | "pdf",
) => {
  const page = await list(organizationId, {
    ...options,
    page: 1,
    limit: EXPORT_MAX,
  });

  const columns: ReportColumn<TimeEntryRow>[] = [
    { header: "Staff member", value: (r) => r.staffName, weight: 1.6 },
    { header: "Matter", value: (r) => r.caseNumber ?? "" },
    { header: "Date", value: (r) => r.entryDate },
    { header: "Hours", value: (r) => r.hoursWorked.toFixed(2), weight: 0.6 },
    { header: "Billable", value: (r) => (r.billable ? "Yes" : "No"), weight: 0.6 },
    {
      header: "Amount",
      value: (r) => (r.rateUnset ? "rate unset" : (r.amount ?? 0).toFixed(2)),
    },
    { header: "Status", value: (r) => r.status, weight: 0.8 },
    { header: "Description", value: (r) => r.description ?? "", weight: 2.5 },
  ];

  const report = await renderReport(format, page.data, columns, {
    title: "Time entries",
    subtitle: `${page.data.length} entr(ies) · ${page.totals.hours.toFixed(2)} billable hrs · exported ${new Date().toISOString().slice(0, 10)}`,
  });

  return {
    filename: `time-entries.${report.extension}`,
    mime: report.mime,
    body: report.body,
  };
};
