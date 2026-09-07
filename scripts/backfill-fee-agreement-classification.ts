import "dotenv/config";
import { isNull, or, sql } from "drizzle-orm";
import { closeDb, systemDb } from "../src/db/client";
import { feeAgreements } from "../src/db/schema/fee-agreements";
import { leads } from "../src/db/schema/leads";

/**
 * Give every existing fee agreement the practice area and case type it is about.
 *
 *   npm run backfill:fee-agreement-classification -- --dry-run
 *   npm run backfill:fee-agreement-classification
 *
 * `generateFeeAgreement` wrote `practiceAreaId: undefined, caseTypeId: undefined`
 * from the day the columns were added, so every row is NULL on both. Nothing
 * read them, so nothing visibly broke — but they are the agreement's own record
 * of what it covers, and the readers that resolve through `leads` instead would
 * restate a signed document if the lead were ever re-classified.
 *
 * **This must run before the NOT NULL migration.** `drizzle/migrations/` is
 * gitignored and local-only, so this script is the only tracked record of the
 * data step; the migration will fail loudly on any remaining NULL rather than
 * corrupting anything, but the order is not optional.
 *
 * Values come from the agreement's own lead, which is the only correct source —
 * `leads.practice_area_id` and `leads.case_type_id` are both NOT NULL and their
 * pair is validated at lead creation, and `fee_agreements.lead_id` is NOT NULL
 * with ON DELETE CASCADE, so every agreement has exactly one live lead to read
 * and the backfill can leave no residue.
 *
 * Uses `systemDb` deliberately: this crosses every tenant, so it must not run
 * under RLS. It only ever fills a NULL — an agreement that already carries a
 * classification is never rewritten.
 *
 * `--dry-run` reports what it would do and writes nothing.
 */
const main = async () => {
  const dryRun = process.argv.includes("--dry-run");

  const pending = await systemDb
    .select({
      id: feeAgreements.id,
      leadId: feeAgreements.leadId,
      status: feeAgreements.status,
      practiceAreaId: leads.practiceAreaId,
      caseTypeId: leads.caseTypeId,
    })
    .from(feeAgreements)
    .innerJoin(leads, sql`${leads.id} = ${feeAgreements.leadId}`)
    .where(
      or(
        isNull(feeAgreements.practiceAreaId),
        isNull(feeAgreements.caseTypeId),
      ),
    );

  console.log(
    `[fee-agreement-classification] ${pending.length} agreement(s) missing a ` +
      `classification${dryRun ? " (dry run)" : ""}`,
  );

  if (pending.length === 0) {
    console.log("[fee-agreement-classification] nothing to do");
    await closeDb();
    return;
  }

  if (dryRun) {
    for (const row of pending) {
      console.log(
        `  would set ${row.id} (${row.status}) -> practice_area=${row.practiceAreaId} ` +
          `case_type=${row.caseTypeId}`,
      );
    }
    await closeDb();
    return;
  }

  // One statement rather than one round-trip per row: this runs against
  // production, and the join is the same one the report above was built from.
  await systemDb.execute(sql`
    update ${feeAgreements} fa
       set practice_area_id = l.practice_area_id,
           case_type_id     = l.case_type_id
      from ${leads} l
     where l.id = fa.lead_id
       and (fa.practice_area_id is null or fa.case_type_id is null)
  `);

  console.log(
    `[fee-agreement-classification] done — ${pending.length} ` +
      "agreement(s) backfilled from their lead",
  );

  const remaining = await systemDb
    .select({ n: sql<number>`count(*)::int` })
    .from(feeAgreements)
    .where(
      or(
        isNull(feeAgreements.practiceAreaId),
        isNull(feeAgreements.caseTypeId),
      ),
    );

  const left = remaining[0]?.n ?? 0;
  if (left > 0) {
    // Only reachable if an agreement lost its lead, which the FK forbids. Say so
    // loudly rather than letting the NOT NULL migration be the one to find out.
    console.error(
      `[fee-agreement-classification] ${left} row(s) still NULL — do NOT run the ` +
        "NOT NULL migration until this is understood",
    );
    await closeDb();
    process.exit(1);
  }

  await closeDb();
};

main().catch(async (err) => {
  console.error("[fee-agreement-classification] failed:", err);
  await closeDb();
  process.exit(1);
});
