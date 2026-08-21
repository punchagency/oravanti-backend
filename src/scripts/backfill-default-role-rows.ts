/**
 * One-time backfill for the dynamic-RBAC default roles.
 *
 * `attorney`, `paralegal`, `legal_assistant`, and `receptionist` used to be
 * compiled-in static roles (see `auth/permissions.ts`). They are now
 * DB-backed `organizationRole` rows instead — the only way for a firm to
 * edit their permissions and "reset to default" for real — seeded
 * automatically for every *new* organization at creation time
 * (`onboarding.service.ts`). This script does the same, once, for every
 * organization that already existed before that change shipped.
 *
 * Ordering matters: this must run BEFORE (or as part of) deploying the code
 * that removes these four names from the org plugin's static `roles` map.
 * Between that deploy and this script completing, any staff member holding
 * one of these roles at an org with no seeded row resolves to zero
 * permissions — `auth.api.hasPermission` finds the name in neither the
 * static map nor the DB. `RolesPermissionsService.getRoles` also self-heals
 * this lazily on every read, but that only helps once someone opens the
 * roles-permissions page for that org — this script is what makes every
 * *existing* org correct immediately, with no gap.
 *
 * Idempotent — only inserts rows that don't already exist (relies on the
 * `organizationRole_organizationId_role_uidx` unique index), so safe to
 * re-run.
 *
 * Run with:  npx tsx src/scripts/backfill-default-role-rows.ts [--dry-run]
 */
import { inArray } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../db/client";
import { organization, organizationRole } from "../db/schema/auth-schema";
import { DEFAULT_ROLE_NAMES, DEFAULT_ROLE_PERMISSIONS } from "../auth/permissions";

const dryRun = process.argv.includes("--dry-run");

const main = async () => {
  const orgs = await db.select({ id: organization.id, name: organization.name }).from(organization);

  const existing = await db
    .select({ organizationId: organizationRole.organizationId, role: organizationRole.role })
    .from(organizationRole)
    .where(inArray(organizationRole.role, [...DEFAULT_ROLE_NAMES]));

  const existingKey = new Set(existing.map((r) => `${r.organizationId}:${r.role}`));

  const toInsert: {
    id: string;
    organizationId: string;
    role: string;
    permission: string;
    createdAt: Date;
  }[] = [];

  for (const org of orgs) {
    for (const roleName of DEFAULT_ROLE_NAMES) {
      if (existingKey.has(`${org.id}:${roleName}`)) continue;
      toInsert.push({
        id: crypto.randomUUID(),
        organizationId: org.id,
        role: roleName,
        permission: JSON.stringify(DEFAULT_ROLE_PERMISSIONS[roleName]),
        createdAt: new Date(),
      });
    }
  }

  console.log(
    [
      "Backfill plan",
      "─────────────",
      `organizations                ${orgs.length}`,
      `default-role rows needed     ${orgs.length * DEFAULT_ROLE_NAMES.length}`,
      `  → already present          ${existing.length}`,
      `  → to insert                ${toInsert.length}`,
    ].join("\n"),
  );

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  if (toInsert.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await db.insert(organizationRole).values(toInsert.slice(i, i + CHUNK)).onConflictDoNothing();
    }
  }

  console.log(`Inserted ${toInsert.length} default-role rows.`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
