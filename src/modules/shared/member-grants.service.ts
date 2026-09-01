import { fromNodeHeaders } from "better-auth/node";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "../../auth";
import { resolveStaticGrants } from "../../auth/permissions";
import { db } from "../../db/client";
import { member, organizationRole } from "../../db/schema/auth-schema";
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

/**
 * Every user in an org whose effective grants include one `resource:action`.
 *
 * The set-shaped counterpart to `resolveMemberGrants`, for the questions that
 * are asked about a whole firm rather than about the caller — "who may sign a
 * fee agreement", and therefore also "may this particular colleague sign one".
 * Answering those by calling `resolveMemberGrants` per member would be a role
 * lookup per member; this is three queries regardless of firm size.
 *
 * Reads `organizationRole` directly rather than through `auth.api.getOrgRole`.
 * That endpoint returns the same row, but one call at a time and only with
 * request headers to hand — and the callers here include a resolver that runs
 * from a webhook, where there is no request. The role names it does not cover
 * (`owner`/`admin`/`client`) come from `resolveStaticGrants`, exactly as in
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
