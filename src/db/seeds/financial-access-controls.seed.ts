/*
  Financial-access-control defaults, applied to one firm.

  These tables were global when this file was written, so it inserted rows with
  no organization_id. They have been per-firm for a long time now, and because
  src/db/seeds sits outside the build's tsconfig, the resulting type error was
  never reported — the script stayed in the tree, broken, and would have thrown
  a not-null violation on the first row had anyone run it.

  It now takes the firm to seed, and the matrix below is the only copy of these
  defaults in the repo, which is why the file is fixed rather than deleted.
*/
import { systemDb } from "../client";
import { financialAccessControls } from "../schema/financial-access-controls";

const defaults = [
  {
    accountType: "operating" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    accountType: "operating" as const,
    role: "attorney" as const,
    permission: "view_only" as const,
  },
  {
    accountType: "operating" as const,
    role: "paralegal" as const,
    permission: "no_access" as const,
  },
  {
    accountType: "operating" as const,
    role: "client" as const,
    permission: "no_access" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "attorney" as const,
    permission: "view_only" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "paralegal" as const,
    permission: "no_access" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "client" as const,
    permission: "no_access" as const,
  },
  // Added when the role enum widened. Both mirror what these roles resolved to
  // BEFORE they were mappable — operating open via `OPERATING_DEFAULT`, no
  // trust — so widening the enum changes nothing until a firm opts in.
  {
    accountType: "operating" as const,
    role: "legal_assistant" as const,
    permission: "full_access" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "legal_assistant" as const,
    permission: "no_access" as const,
  },
  {
    accountType: "operating" as const,
    role: "receptionist" as const,
    permission: "full_access" as const,
  },
  {
    accountType: "trust_iolta" as const,
    role: "receptionist" as const,
    permission: "no_access" as const,
  },
];

/**
 * Give a firm its default financial-access matrix.
 *
 * Idempotent — `onConflictDoNothing` against the unique
 * (organization, accountType, role) — so onboarding, the backfill and a manual
 * re-run all converge on the same eight rows without disturbing a firm that has
 * since changed them.
 *
 * **`systemDb`, not `db`.** This table is org-scoped under a RESTRICTIVE RLS
 * policy, and the caller that matters runs during onboarding, before
 * `app.current_organization_id` has been set to the org being created — so an
 * insert through the tenant client matches no policy and writes nothing. Same
 * reasoning, and the same choice, as `seedDefaultRoleRows`.
 */
export const seedFinancialAccessControls = async (organizationId: string) => {
  await systemDb
    .insert(financialAccessControls)
    .values(defaults.map((d) => ({ ...d, organizationId })))
    .onConflictDoNothing();
};

if (require.main === module) {
  const organizationId = process.argv[2];
  if (!organizationId) {
    console.error(
      "usage: tsx src/db/seeds/financial-access-controls.seed.ts <organizationId>",
    );
    process.exit(1);
  }
  console.log("Seeding financial access controls...");
  seedFinancialAccessControls(organizationId)
    .then(() => {
      console.log("Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
