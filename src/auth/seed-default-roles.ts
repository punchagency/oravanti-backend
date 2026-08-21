import { and, eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import { systemDb } from "../db/client";
import { organizationRole } from "../db/schema/auth-schema";
import { DEFAULT_ROLE_NAMES, DEFAULT_ROLE_PERMISSIONS } from "./permissions";

/**
 * Ensures every default role (attorney, paralegal, legal_assistant,
 * receptionist) has a DB-backed `organizationRole` row for this org, seeded
 * with the factory-default grants (`DEFAULT_ROLE_PERMISSIONS`) for any that
 * are missing. These four are intentionally not part of the org plugin's
 * static `roles` map (see `permissions.ts`) precisely so they can be real,
 * editable, resettable rows — which means every org must actually have the
 * rows, or a staff member holding one of these roles resolves to zero
 * grants. Called at firm creation (fresh orgs) and defensively from the
 * roles-permissions read paths (self-heals any org missing them). Idempotent
 * — safe to call repeatedly, including concurrently, for the same org.
 */
export async function seedDefaultRoleRows(organizationId: string): Promise<void> {
  const existing = await systemDb
    .select({ role: organizationRole.role })
    .from(organizationRole)
    .where(
      and(
        eq(organizationRole.organizationId, organizationId),
        inArray(organizationRole.role, [...DEFAULT_ROLE_NAMES]),
      ),
    );

  const existingNames = new Set(existing.map((row) => row.role));
  const missing = DEFAULT_ROLE_NAMES.filter((name) => !existingNames.has(name));
  if (missing.length === 0) return;

  await systemDb
    .insert(organizationRole)
    .values(
      missing.map((name) => ({
        id: crypto.randomUUID(),
        organizationId,
        role: name,
        permission: JSON.stringify(DEFAULT_ROLE_PERMISSIONS[name]),
        createdAt: new Date(),
      })),
    )
    // Another concurrent request may have seeded the same row between our
    // read above and this write — ignore rather than fail the caller.
    .onConflictDoNothing();
}
