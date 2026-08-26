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

/**
 * Grants existing default-role rows any resource added to the statement since
 * they were seeded.
 *
 * `seedDefaultRoleRows` only ever inserts *missing roles*, so a new resource
 * (`tasks`, when the workflow engine landed) reaches brand-new orgs through
 * `DEFAULT_ROLE_PERMISSIONS` and reaches existing ones through nothing at all
 * — their stored JSON simply has no such key, and every member of that role
 * is denied the new surface with no visible cause. This closes that gap.
 *
 * **Additive only.** A key already present is left exactly as it is, so a firm
 * that narrowed `cases` or widened `finance` on their attorney role keeps that
 * edit; only genuinely absent keys are filled from the factory baseline.
 * Custom roles a firm authored are not touched at all — silently granting a
 * new permission to a hand-built role is the firm admin's call, not ours.
 *
 * Idempotent: a second run finds nothing missing and writes nothing.
 */
export async function backfillDefaultRolePermissions(): Promise<{ scanned: number; updated: number }> {
  const rows = await systemDb
    .select({ id: organizationRole.id, role: organizationRole.role, permission: organizationRole.permission })
    .from(organizationRole)
    .where(inArray(organizationRole.role, [...DEFAULT_ROLE_NAMES]));

  let updated = 0;

  for (const row of rows) {
    const factory = DEFAULT_ROLE_PERMISSIONS[row.role as (typeof DEFAULT_ROLE_NAMES)[number]];
    if (!factory) continue;

    let stored: Record<string, readonly string[]>;
    try {
      stored = JSON.parse(row.permission ?? "{}");
    } catch {
      // Unparseable grant JSON is a pre-existing problem this backfill must
      // not paper over by overwriting it with defaults.
      continue;
    }

    const missingKeys = Object.keys(factory).filter((key) => !(key in stored));
    if (missingKeys.length === 0) continue;

    const merged = { ...stored };
    for (const key of missingKeys) merged[key] = factory[key];

    await systemDb
      .update(organizationRole)
      .set({ permission: JSON.stringify(merged) })
      .where(eq(organizationRole.id, row.id));
    updated++;
  }

  return { scanned: rows.length, updated };
}
