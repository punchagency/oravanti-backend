/**
 * One-time backfill for the finance module's time-entry columns.
 *
 * The migration adds `status` with a default of 'pending', so without this
 * every time entry the firm has ever logged would show up as awaiting
 * approval and the Time & Billing tab would open with a false backlog of the
 * firm's entire history.
 *
 * Three steps, in order:
 *
 *   1. Seed `billing_rates` from `staff.hourly_rate` — one open row per staff
 *      member, effective from the day they were created.
 *   2. Mark pre-existing entries approved and billable.
 *   3. Fill `hourly_rate` / `amount` on those entries by resolving the rate as
 *      at each entry's OWN date, set-based.
 *
 * What it deliberately does NOT do: seed a rate for staff whose
 * `staff.hourly_rate` is 0 (the column's default). A rate row of 0 asserts
 * "this person bills nothing"; no row at all reports `rateUnset`, which is what
 * lets the UI prompt "set staff rates" instead of quietly rendering $0.00
 * everywhere. A firm that never configured rates should be told so, not shown
 * a broken-looking tab.
 *
 * Idempotent. Only touches entries created before this run that have never been
 * approved or invoiced, and only seeds a rate where no row exists yet.
 *
 * Run with:  npx tsx src/scripts/backfill-time-entry-status.ts [--dry-run]
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { billingRates } from "../db/schema/billing-rates";
import { staff } from "../db/schema/staff";
import { timeEntries } from "../db/schema/time-entries";

const dryRun = process.argv.includes("--dry-run");

const main = async () => {
  const startedAt = new Date();

  // ── 1. Seed billing rates ──────────────────────────────────────────────────
  const staffRows = await db
    .select({
      id: staff.id,
      organizationId: staff.organizationId,
      hourlyRate: staff.hourlyRate,
      createdAt: staff.createdAt,
    })
    .from(staff);

  const existingRates = await db
    .selectDistinct({ staffId: billingRates.staffId })
    .from(billingRates)
    .where(sql`${billingRates.staffId} IS NOT NULL`);
  const alreadyRated = new Set(existingRates.map((r) => r.staffId));

  const seedable = staffRows.filter((s) => {
    if (alreadyRated.has(s.id)) return false;
    const rate = parseFloat(s.hourlyRate ?? "0");
    return Number.isFinite(rate) && rate > 0;
  });

  const skippedNoRate = staffRows.filter((s) => {
    if (alreadyRated.has(s.id)) return false;
    const rate = parseFloat(s.hourlyRate ?? "0");
    return !(Number.isFinite(rate) && rate > 0);
  }).length;

  // ── 2 & 3 targets ──────────────────────────────────────────────────────────
  const [pendingCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(
      and(
        lt(timeEntries.createdAt, startedAt),
        eq(timeEntries.status, "pending"),
        isNull(timeEntries.approvedAt),
        isNull(timeEntries.invoicedAt),
      ),
    );

  console.log(
    [
      "Backfill plan",
      "─────────────",
      `staff rows                     ${staffRows.length}`,
      `  → rates to seed              ${seedable.length}`,
      `  → skipped (already rated)    ${alreadyRated.size}`,
      `  → skipped (hourly_rate = 0)  ${skippedNoRate}  ← will report rateUnset`,
      `time entries to approve+price  ${pendingCount?.n ?? 0}`,
    ].join("\n"),
  );

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  if (seedable.length > 0) {
    const CHUNK = 500;
    const rows = seedable.map((s) => ({
      organizationId: s.organizationId,
      staffId: s.id,
      role: null,
      rate: parseFloat(s.hourlyRate ?? "0").toFixed(2),
      // Effective from the day the staff member was created, so entries dated
      // any time in their history resolve rather than falling through to
      // rateUnset.
      effectiveFrom: s.createdAt.toISOString().slice(0, 10),
      effectiveTo: null,
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(billingRates).values(rows.slice(i, i + CHUNK));
    }
    console.log(`Seeded ${rows.length} billing rates.`);
  }

  // Approve + mark billable. Done before pricing so the pricing step can key
  // off the same predicate.
  const approved = await db
    .update(timeEntries)
    .set({ status: "approved", billable: true, updatedAt: new Date() })
    .where(
      and(
        lt(timeEntries.createdAt, startedAt),
        eq(timeEntries.status, "pending"),
        isNull(timeEntries.approvedAt),
        isNull(timeEntries.invoicedAt),
      ),
    )
    .returning({ id: timeEntries.id });

  console.log(`Approved ${approved.length} historical time entries.`);

  // Price them, resolving each entry's rate as at its OWN entry_date — not
  // today's rate. One statement for the whole table.
  // The LATERAL correlates inside the subquery rather than against the UPDATE
  // target: an UPDATE's target table is not in scope for a LATERAL in its FROM
  // clause (Postgres 42P10).
  const priced = await db.execute(sql`
    UPDATE time_entries te
       SET hourly_rate = resolved.rate,
           amount      = round(te.hours_worked * resolved.rate, 2),
           updated_at  = now()
      FROM (
        SELECT t.id, r.rate
          FROM time_entries t
          JOIN staff s ON s.id = t.staff_id
          LEFT JOIN LATERAL (
            SELECT b.rate
              FROM billing_rates b
             WHERE b.organization_id = t.organization_id
               AND b.effective_from <= t.entry_date
               AND (b.effective_to IS NULL OR t.entry_date < b.effective_to)
               AND (b.staff_id = t.staff_id
                    OR (b.staff_id IS NULL AND b.role = s.role))
             ORDER BY (b.staff_id IS NOT NULL) DESC, b.effective_from DESC
             LIMIT 1
          ) r ON TRUE
         WHERE t.created_at < ${startedAt.toISOString()}::timestamp
           AND t.hourly_rate IS NULL
           AND t.invoiced_at IS NULL
      ) resolved
     WHERE resolved.id = te.id
       AND resolved.rate IS NOT NULL
  `);

  const pricedCount =
    (priced as unknown as { count?: number }).count ??
    (Array.isArray(priced) ? priced.length : 0);
  console.log(`Priced ${pricedCount} time entries.`);

  const [unpriced] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(isNull(timeEntries.hourlyRate));
  if ((unpriced?.n ?? 0) > 0) {
    console.log(
      `\n${unpriced!.n} entries still have no rate — their staff member has no ` +
        `billing rate configured. They will report rateUnset so the UI can ` +
        `prompt for rates rather than showing $0.00.`,
    );
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
