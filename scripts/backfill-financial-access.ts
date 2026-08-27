import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, systemDb } from "../src/db/client";
import { organization } from "../src/db/schema/auth-schema";
import { financialAccessControls } from "../src/db/schema/financial-access-controls";
import { seedFinancialAccessControls } from "../src/db/seeds/financial-access-controls.seed";

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
 * Idempotent twice over: the seed is `onConflictDoNothing`, and a firm that
 * already has rows is skipped outright, so a firm that has since customised its
 * matrix is never quietly reset to the defaults.
 *
 * `--dry-run` reports what it would do and writes nothing.
 */
const main = async () => {
  const dryRun = process.argv.includes("--dry-run");

  const orgs = await systemDb
    .select({ id: organization.id, name: organization.name })
    .from(organization);

  // One query rather than one per firm: this runs against production.
  const counts = await systemDb
    .select({
      organizationId: financialAccessControls.organizationId,
      n: sql<number>`count(*)::int`,
    })
    .from(financialAccessControls)
    .groupBy(financialAccessControls.organizationId);

  const configured = new Map(counts.map((c) => [c.organizationId, c.n]));
  const missing = orgs.filter((o) => (configured.get(o.id) ?? 0) === 0);

  console.log(
    `[financial-access] ${orgs.length} firms · ${orgs.length - missing.length} already configured · ` +
      `${missing.length} to seed${dryRun ? " (dry run)" : ""}`,
  );

  for (const org of missing) {
    if (dryRun) {
      console.log(`  would seed  ${org.id}  ${org.name}`);
      continue;
    }
    await seedFinancialAccessControls(org.id);
    console.log(`  seeded      ${org.id}  ${org.name}`);
  }

  if (!dryRun && missing.length > 0) {
    console.log(
      `[financial-access] done — ${missing.length} firms seeded, ` +
        "admins now have trust access and attorneys view-only",
    );
  }

  await closeDb();
};

main().catch(async (err) => {
  console.error("[financial-access] failed:", err);
  await closeDb();
  process.exit(1);
});
