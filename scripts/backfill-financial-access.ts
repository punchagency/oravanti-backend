import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, systemDb } from "../src/db/client";
import { organization } from "../src/db/schema/auth-schema";
import { financialAccessControls } from "../src/db/schema/financial-access-controls";
import {
  accountTypeEnum,
  permissionRoleEnum,
} from "../src/db/schema/financial-access-controls";
import { seedFinancialAccessControls } from "../src/db/seeds/financial-access-controls.seed";

/**
 * How many rows a fully-seeded firm has: one per (account type, role).
 *
 * Derived rather than hardcoded, so widening either enum again automatically
 * re-flags every firm as incomplete instead of silently leaving them short.
 */
const EXPECTED_ROWS =
  accountTypeEnum.enumValues.length * permissionRoleEnum.enumValues.length;

/**
 * Give every existing firm its financial-access defaults.
 *
 *   npm run backfill:financial-access
 *
 * `seedFinancialAccessControls` was written but never called from onboarding,
 * so `financial_access_controls` was empty for every firm — and trust (IOLTA)
 * access is deny-by-default. The effect was that nobody at any firm, including
 * the Super admin, could touch trust money, with no way to grant it from inside
 * the product. Onboarding now seeds new firms; this catches the ones already
 * created.
 *
 * Runs against EVERY firm, including ones already seeded. That is deliberate:
 * the role enum has since widened, so a firm seeded before `legal_assistant`
 * and `receptionist` existed is missing their rows and cannot configure them.
 * Skipping "already configured" firms — which this used to do — would leave
 * exactly those firms behind.
 *
 * Safe because the seed is `onConflictDoNothing` against the unique
 * (organization, accountType, role): it adds what is missing and never
 * overwrites a choice a firm has already made.
 *
 * `--dry-run` reports what it would do and writes nothing.
 */
const main = async () => {
  const dryRun = process.argv.includes("--dry-run");

  const orgs = await systemDb
    .select({ id: organization.id, name: organization.name })
    .from(organization);

  // One query rather than one per firm: this runs against production.
  const before = await systemDb
    .select({
      organizationId: financialAccessControls.organizationId,
      n: sql<number>`count(*)::int`,
    })
    .from(financialAccessControls)
    .groupBy(financialAccessControls.organizationId);

  const rowsFor = new Map(before.map((c) => [c.organizationId, c.n]));
  const expected = EXPECTED_ROWS;

  const incomplete = orgs.filter((o) => (rowsFor.get(o.id) ?? 0) < expected);

  console.log(
    `[financial-access] ${orgs.length} firms · ${orgs.length - incomplete.length} complete · ` +
      `${incomplete.length} missing rows${dryRun ? " (dry run)" : ""}`,
  );

  for (const org of incomplete) {
    const had = rowsFor.get(org.id) ?? 0;
    if (dryRun) {
      console.log(`  would add ${expected - had} row(s)  ${org.id}  ${org.name}`);
      continue;
    }
    await seedFinancialAccessControls(org.id);
    console.log(`  +${expected - had} row(s)  ${org.id}  ${org.name}`);
  }

  if (!dryRun && incomplete.length > 0) {
    console.log(
      `[financial-access] done — ${incomplete.length} firms topped up to ${expected} rows; ` +
        "existing choices left untouched",
    );
  }

  await closeDb();
};

main().catch(async (err) => {
  console.error("[financial-access] failed:", err);
  await closeDb();
  process.exit(1);
});
