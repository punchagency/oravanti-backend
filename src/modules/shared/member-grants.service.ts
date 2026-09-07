import { fromNodeHeaders } from "better-auth/node";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "../../auth";
import { resolveStaticGrants } from "../../auth/permissions";
import { db } from "../../db/client";
import { member } from "../../db/schema/auth-schema";
import { roleGroup, roleGroupMember } from "../../db/schema/role-groups";

type Headers = Record<string, string | string[] | undefined>;

/**
 * Every `resource:action` grant a staff member actually has in an org —
 * direct roles (`member.role`) unioned with roles inherited from any role
 * group they belong to. This is the single place that resolution happens;
 * `requirePermission` (the real request gate) and `getMyGrants` (what the
 * frontend's `useHasPermission` reads) both call it, because divergence
 * between them is exactly how a member added to a role group could show as
 * having access in the UI while every request still 403s.
 *
 * Asking the same question of a whole firm at once is
 * `listUserIdsWithGrant` in `grant-holders.service.ts`, which lives apart
 * because it needs no better-auth instance and its callers must not acquire one.
 */
export async function resolveMemberGrants(
  userId: string,
  organizationId: string,
  headers: Headers,
): Promise<Set<string>> {
  const [memberRecord] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);

  if (!memberRecord) return new Set();

  const directRoles = memberRecord.role.split(",").map((r) => r.trim()).filter(Boolean);

  const memberships = await db
    .select({ groupId: roleGroupMember.groupId })
    .from(roleGroupMember)
    .where(eq(roleGroupMember.memberId, memberRecord.id));

  const groupRoleNames = new Set<string>();
  if (memberships.length > 0) {
    const groupIds = memberships.map((m) => m.groupId);
    const groups = await db
      .select({ roles: roleGroup.roles })
      .from(roleGroup)
      .where(inArray(roleGroup.id, groupIds));

    for (const g of groups) {
      if (g.roles) {
        for (const r of g.roles.split(",").map((r) => r.trim()).filter(Boolean)) {
          groupRoleNames.add(r);
        }
      }
    }
  }

  // Union of direct + group roles
  const allRoleNames = Array.from(new Set([...directRoles, ...groupRoleNames]));
  const grants = new Set(resolveStaticGrants(allRoleNames));

  // `owner`/`admin`/`client` are the only three roles resolved statically
  // (see `ALL_STATIC_ROLES` in `auth/permissions.ts`) — already covered by
  // `resolveStaticGrants` above. Every other role name, including the four
  // seeded defaults, is a real DB row and must be read from `organizationRole`.
  const dbRoleNames = allRoleNames.filter(
    (name) => name !== "owner" && name !== "admin" && name !== "client",
  );
  for (const roleName of dbRoleNames) {
    try {
      const customRole = (await auth.api.getOrgRole({
        query: { roleName, organizationId },
        headers: fromNodeHeaders(headers as Record<string, string>),
      })) as { permission?: Record<string, string[]> } | null;
      if (customRole?.permission) {
        for (const [resource, actions] of Object.entries(customRole.permission)) {
          for (const action of actions) grants.add(`${resource}:${action}`);
        }
      }
    } catch {
      // Role no longer exists (deleted between session issue and this
      // read) — skip it rather than fail the whole grants lookup.
    }
  }

  return grants;
}
