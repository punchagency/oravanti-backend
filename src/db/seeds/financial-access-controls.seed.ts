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
import { db } from "../client";
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
];

export const seedFinancialAccessControls = async (organizationId: string) => {
  await db
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
