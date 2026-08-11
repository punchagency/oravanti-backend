import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { billingRates } from "../../db/schema/billing-rates";
import { staff } from "../../db/schema/staff";
import { withTransaction } from "../../db/transaction-context";
import { BadRequestError } from "../../utils/error/app-error";
import { money, num, toMoney } from "./money";

/**
 * Rate resolution — the source of truth for what an hour of work is worth.
 *
 * The rule that matters: resolve by the ENTRY's date, never `now()`.
 *
 * `staff.hourlyRate` is a single mutable scalar. Anything computed from it at
 * read time silently restates history the moment someone gets a raise, and work
 * logged a fortnight late gets valued at today's rate rather than the rate that
 * applied when it was actually done. `revenue-analytics.service.ts` had exactly
 * that bug.
 *
 * A personal rate beats the firm's role default; the role default is what stops
 * a new hire with no rate row from billing at zero.
 *
 * The resolved rate is snapshotted onto the time entry by the caller and frozen
 * once the entry is invoiced — see time-billing.service.ts.
 */

export type ResolvedRate = {
  /** Null when neither a personal rate nor a role default covers the date. */
  rate: number | null;
  source: "staff" | "role" | "none";
};

/**
 * Resolve one staff member's rate as at `entryDate` (YYYY-MM-DD).
 *
 * Ordering puts personal rates first, so a single LIMIT 1 picks the more
 * specific row without a second query.
 */
export const resolveBillingRate = async (
  organizationId: string,
  staffId: string,
  entryDate: string,
): Promise<ResolvedRate> => {
  const [member] = await db
    .select({ role: staff.role })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
    .limit(1);

  const [row] = await db
    .select({
      rate: billingRates.rate,
      staffId: billingRates.staffId,
    })
    .from(billingRates)
    .where(
      and(
        eq(billingRates.organizationId, organizationId),
        sql`${billingRates.effectiveFrom} <= ${entryDate}`,
        or(
          isNull(billingRates.effectiveTo),
          sql`${entryDate} < ${billingRates.effectiveTo}`,
        ),
        member?.role
          ? or(
              eq(billingRates.staffId, staffId),
              and(
                isNull(billingRates.staffId),
                eq(billingRates.role, member.role),
              ),
            )
          : eq(billingRates.staffId, staffId),
      ),
    )
    // A personal row outranks a role default; among equals the later
    // effective_from wins (there can only be one open row per target anyway).
    .orderBy(
      sql`(${billingRates.staffId} IS NOT NULL) DESC`,
      desc(billingRates.effectiveFrom),
    )
    .limit(1);

  if (!row) return { rate: null, source: "none" };
  return {
    rate: num(row.rate),
    source: row.staffId ? "staff" : "role",
  };
};

export type RateResolutionRequest = {
  staffId: string;
  entryDate: string;
};

export type RateResolutionResult = ResolvedRate & {
  staffId: string;
  entryDate: string;
};

/**
 * Set-based resolution for the bulk paths — converting many time entries onto
 * an invoice, and the backfill.
 *
 * One query for the whole batch. Resolving per entry would be the same N+1 the
 * rest of this module goes out of its way to avoid.
 */
export const resolveBillingRates = async (
  organizationId: string,
  requests: RateResolutionRequest[],
): Promise<Map<string, RateResolutionResult>> => {
  const out = new Map<string, RateResolutionResult>();
  if (requests.length === 0) return out;

  const values = sql.join(
    requests.map(
      (r) => sql`(${r.staffId}::uuid, ${r.entryDate}::date)`,
    ),
    sql`, `,
  );

  const rows = await db.execute<{
    staff_id: string;
    entry_date: string;
    rate: string | null;
    source: string | null;
  }>(sql`
    WITH wanted(staff_id, entry_date) AS (VALUES ${values})
    SELECT w.staff_id,
           to_char(w.entry_date, 'YYYY-MM-DD') AS entry_date,
           r.rate,
           CASE WHEN r.staff_id IS NOT NULL THEN 'staff'
                WHEN r.id IS NOT NULL       THEN 'role'
                ELSE NULL END AS source
      FROM wanted w
      JOIN staff s ON s.id = w.staff_id
      LEFT JOIN LATERAL (
        SELECT b.id, b.rate, b.staff_id
          FROM billing_rates b
         WHERE b.organization_id = ${organizationId}
           AND b.effective_from <= w.entry_date
           AND (b.effective_to IS NULL OR w.entry_date < b.effective_to)
           AND (b.staff_id = w.staff_id OR (b.staff_id IS NULL AND b.role = s.role))
         ORDER BY (b.staff_id IS NOT NULL) DESC, b.effective_from DESC
         LIMIT 1
      ) r ON TRUE
  `);

  for (const row of rows as unknown as {
    staff_id: string;
    entry_date: string;
    rate: string | null;
    source: string | null;
  }[]) {
    out.set(rateKey(row.staff_id, row.entry_date), {
      staffId: row.staff_id,
      entryDate: row.entry_date,
      rate: row.rate == null ? null : num(row.rate),
      source: (row.source as "staff" | "role" | null) ?? "none",
    });
  }

  return out;
};

/** Map key for `resolveBillingRates` results. */
export const rateKey = (staffId: string, entryDate: string): string =>
  `${staffId}:${entryDate}`;

/** hours x rate, rounded to the 2dp a client is actually billed. */
export const computeAmount = (
  hours: number,
  resolved: number | null,
): number | null => (resolved == null ? null : toMoney(hours * resolved));

// ── Writes ───────────────────────────────────────────────────────────────────

export type SetRateInput = {
  organizationId: string;
  /** Exactly one of staffId / role. */
  staffId?: string | null;
  role?: "admin" | "attorney" | "paralegal" | null;
  rate: number;
  effectiveFrom: string;
  createdById?: string | null;
};

/**
 * Record a new rate.
 *
 * A rate change is an INSERT, never an UPDATE — history is the whole point of
 * the table. The currently-open row for the same target is closed at the new
 * row's `effectiveFrom`, in the same transaction, which is what keeps the
 * partial unique index on `effective_to IS NULL` satisfiable and stops the two
 * ranges overlapping.
 */
export const setBillingRate = async (input: SetRateInput) => {
  const targetsStaff = input.staffId != null;
  const targetsRole = input.role != null;
  if (targetsStaff === targetsRole) {
    throw new BadRequestError(
      "A billing rate must target either a staff member or a role, not both",
    );
  }

  return withTransaction(db, async () => {
    // Matches exactly the row the partial unique index would collide with.
    const targetPredicate = targetsStaff
      ? eq(billingRates.staffId, input.staffId!)
      : and(isNull(billingRates.staffId), eq(billingRates.role, input.role!));

    const [open] = await db
      .select({
        id: billingRates.id,
        effectiveFrom: billingRates.effectiveFrom,
      })
      .from(billingRates)
      .where(
        and(
          eq(billingRates.organizationId, input.organizationId),
          isNull(billingRates.effectiveTo),
          targetPredicate,
        ),
      )
      .limit(1);

    if (open) {
      // A new rate cannot start before the one it supersedes — the
      // billing_rates_range_ordered check would reject the closing update, and
      // an out-of-order history is not meaningful anyway.
      if (open.effectiveFrom >= input.effectiveFrom) {
        throw new BadRequestError(
          `A rate effective ${open.effectiveFrom} already exists; the new rate must start after it`,
        );
      }
      await db
        .update(billingRates)
        .set({ effectiveTo: input.effectiveFrom })
        .where(eq(billingRates.id, open.id));
    }

    const [created] = await db
      .insert(billingRates)
      .values({
        organizationId: input.organizationId,
        staffId: input.staffId ?? null,
        role: input.role ?? null,
        rate: money(input.rate),
        effectiveFrom: input.effectiveFrom,
        createdById: input.createdById ?? null,
      })
      .returning();

    return created!;
  });
};

/** Every rate row for the firm, newest first — the settings/history view. */
export const listBillingRates = async (organizationId: string) => {
  const rows = await db
    .select({
      id: billingRates.id,
      staffId: billingRates.staffId,
      staffFirstName: staff.firstName,
      staffLastName: staff.lastName,
      role: billingRates.role,
      rate: billingRates.rate,
      effectiveFrom: billingRates.effectiveFrom,
      effectiveTo: billingRates.effectiveTo,
      createdAt: billingRates.createdAt,
    })
    .from(billingRates)
    .leftJoin(staff, eq(staff.id, billingRates.staffId))
    .where(eq(billingRates.organizationId, organizationId))
    .orderBy(desc(billingRates.effectiveFrom), desc(billingRates.createdAt));

  return rows.map((r) => ({
    id: r.id,
    staffId: r.staffId,
    staffName: r.staffId
      ? `${r.staffFirstName ?? ""} ${r.staffLastName ?? ""}`.trim() || null
      : null,
    role: r.role,
    rate: num(r.rate),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isOpen: r.effectiveTo == null,
    createdAt: r.createdAt,
  }));
};
