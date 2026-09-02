import { eq } from "drizzle-orm";
import { resolveStaticGrants } from "../../auth/permissions";
import { db } from "../../db/client";
import { member, organizationRole } from "../../db/schema/auth-schema";
import { roleGroup, roleGroupMember } from "../../db/schema/role-groups";

/**
 * Grant resolution across a whole organization.
 *
 * Its own module, and not for tidiness. The sibling `member-grants.service.ts`
 * answers "what may this caller do" and needs `auth.api.getOrgRole` to do it,
 * which means importing the configured better-auth instance and with it that
 * package's ESM-only crypto path. `leads.service.ts` reaches the function
 * below, and dragging that instance into the biggest module in the codebase
 * broke every jest suite loading it — on dependencies the transform allowlist
 * does not cover. Keeping this side free of an instance it never uses is the
 * fix; widening the allowlist until the symptom stops is not.
 */

/**
 * Every user in an org whose effective grants include one `resource:action`.
 *
 * The set-shaped counterpart to `resolveMemberGrants`, for questions asked
 * about a whole firm rather than about the caller — "who may sign a fee
 * agreement", and therefore also "may this particular colleague sign one".
 * Answering those through `resolveMemberGrants` would be a role lookup per
 * member; this is three queries regardless of firm size.
 *
 * Reads `organizationRole` directly rather than through `auth.api.getOrgRole`.
 * That endpoint returns the same row, but one call at a time and only with
 * request headers to hand — and one caller here runs from a webhook, where
 * there is no request. The role names it does not cover (`owner`/`admin`/
 * `client`) come from `resolveStaticGrants`, exactly as in
 * `resolveMemberGrants`, so the two agree on what a role name means.
 */
export async function listUserIdsWithGrant(
  organizationId: string,
  grant: string,
): Promise<Set<string>> {
  const members = await db
    .select({ id: member.id, userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, organizationId));

  if (members.length === 0) return new Set();

  // memberId → role names inherited from every group they belong to.
  const groupRolesByMember = new Map<string, string[]>();
  const groupRows = await db
    .select({ memberId: roleGroupMember.memberId, roles: roleGroup.roles })
    .from(roleGroupMember)
    .innerJoin(roleGroup, eq(roleGroup.id, roleGroupMember.groupId))
    .where(eq(roleGroup.organizationId, organizationId));

  for (const row of groupRows) {
    const names = (row.roles ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const existing = groupRolesByMember.get(row.memberId);
    if (existing) existing.push(...names);
    else groupRolesByMember.set(row.memberId, names);
  }

  const dbRoleRows = await db
    .select({ role: organizationRole.role, permission: organizationRole.permission })
    .from(organizationRole)
    .where(eq(organizationRole.organizationId, organizationId));

  // Resolve each role name once, not once per member holding it.
  const roleGrants = new Map<string, Set<string>>();
  for (const row of dbRoleRows) {
    const grants = new Set<string>();
    try {
      const permission = JSON.parse(row.permission ?? "{}") as Record<
        string,
        string[]
      >;
      for (const [resource, actions] of Object.entries(permission)) {
        for (const action of actions ?? []) grants.add(`${resource}:${action}`);
      }
    } catch {
      // Unparseable grant JSON denies rather than throws — the same posture
      // `backfillDefaultRolePermissions` takes when it meets one.
    }
    roleGrants.set(row.role, grants);
  }

  const holders = new Set<string>();
  for (const m of members) {
    const roleNames = new Set([
      ...m.role.split(",").map((r) => r.trim()).filter(Boolean),
      ...(groupRolesByMember.get(m.id) ?? []),
    ]);

    const names = Array.from(roleNames);
    const hasStatic = resolveStaticGrants(names).includes(grant);
    const hasDb = names.some((name) => roleGrants.get(name)?.has(grant));
    if (hasStatic || hasDb) holders.add(m.userId);
  }

  return holders;
}
