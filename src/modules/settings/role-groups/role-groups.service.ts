import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { member } from "../../../db/schema/auth-schema";
import { roleGroup, roleGroupMember } from "../../../db/schema/role-groups";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../utils/error/app-error";
import { parsePaginationQuery } from "../../../utils/pagination";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";
import { LogEvent } from "../../../lib/logging/events";

const log = createModuleLogger("role-groups.service");

export class RoleGroupsService {
  /**
   * Role groups for this org, enriched with live member counts and resolved
   * role labels. Supports server-side search (`q` across name, description
   * and bundled role names) and pagination; omitting page/limit returns the
   * full filtered list for pickers.
   */
  listGroups = async (
    organizationId: string,
    query: { q?: string; page?: number; limit?: number } = {},
  ) => {
    const conditions: ReturnType<typeof sql>[] = [
      eq(roleGroup.organizationId, organizationId),
    ];

    const q = query.q?.trim().toLowerCase();
    if (q) {
      const like = `%${q}%`;
      // `roles` is a CSV column, so a substring match covers role names too.
      conditions.push(
        or(
          sql`LOWER(${roleGroup.name}) LIKE ${like}`,
          sql`LOWER(${roleGroup.description}) LIKE ${like}`,
          sql`LOWER(${roleGroup.roles}) LIKE ${like}`,
        )!,
      );
    }

    const where = and(...conditions);

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(roleGroup)
      .where(where);
    const total = Number(count);

    let rowsQuery = db
      .select()
      .from(roleGroup)
      .where(where)
      .orderBy(roleGroup.createdAt)
      .$dynamic();

    if (query.page !== undefined || query.limit !== undefined) {
      const { page, limit } = parsePaginationQuery(query);
      rowsQuery = rowsQuery.limit(limit).offset((page - 1) * limit);
    }

    const groups = await rowsQuery;

    const groupIds = groups.map((g) => g.id);
    if (groupIds.length === 0) return { groups: [], total };

    // Count members per group in one query
    const memberCounts = await db
      .select({ groupId: roleGroupMember.groupId })
      .from(roleGroupMember)
      .where(inArray(roleGroupMember.groupId, groupIds));

    const counts: Record<string, number> = {};
    for (const row of memberCounts) {
      counts[row.groupId] = (counts[row.groupId] ?? 0) + 1;
    }

    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description ?? "",
        roles: g.roles ? g.roles.split(",").map((r) => r.trim()).filter(Boolean) : [],
        memberCount: counts[g.id] ?? 0,
        createdAt: g.createdAt,
      })),
      total,
    };
  };

  /**
   * Every membership across all of this org's role groups, in one query —
   * used to build a memberId -> group names map without an N+1 fan-out
   * over `getGroupById` per group.
   */
  listMemberships = async (
    organizationId: string,
  ): Promise<{ memberId: string; groupName: string }[]> => {
    return db
      .select({ memberId: roleGroupMember.memberId, groupName: roleGroup.name })
      .from(roleGroupMember)
      .innerJoin(roleGroup, eq(roleGroupMember.groupId, roleGroup.id))
      .where(eq(roleGroup.organizationId, organizationId));
  };

  getGroupById = async (organizationId: string, groupId: string) => {
    const [group] = await db
      .select()
      .from(roleGroup)
      .where(and(eq(roleGroup.id, groupId), eq(roleGroup.organizationId, organizationId)))
      .limit(1);

    if (!group) throw new NotFoundError("Role group not found");

    const members = await db
      .select({
        id: roleGroupMember.id,
        memberId: roleGroupMember.memberId,
        createdAt: roleGroupMember.createdAt,
      })
      .from(roleGroupMember)
      .where(eq(roleGroupMember.groupId, groupId));

    // Fetch member details (userId, role) for each
    const memberIds = members.map((m) => m.memberId);
    const memberDetails =
      memberIds.length > 0
        ? await db
            .select({ id: member.id, userId: member.userId, role: member.role })
            .from(member)
            .where(inArray(member.id, memberIds))
        : [];

    const memberMap = new Map(memberDetails.map((m) => [m.id, m]));

    return {
      id: group.id,
      name: group.name,
      description: group.description ?? "",
      roles: group.roles ? group.roles.split(",").map((r) => r.trim()).filter(Boolean) : [],
      members: members.map((m) => {
        const detail = memberMap.get(m.memberId);
        return {
          groupMembershipId: m.id,
          memberId: m.memberId,
          userId: detail?.userId ?? "",
          directRoles: detail?.role ?? "",
          addedAt: m.createdAt,
        };
      }),
      createdAt: group.createdAt,
    };
  };

  createGroup = async (
    organizationId: string,
    input: { name: string; description?: string; roles: string[] },
  ) => {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("Group name is required");

    const rolesStr = input.roles.join(",");

    let group;
    try {
      [group] = await db
        .insert(roleGroup)
        .values({
          organizationId,
          name,
          description: input.description ?? "",
          roles: rolesStr,
        })
        .returning();
    } catch (err: any) {
      if (err?.code === "23505") {
        throw new ConflictError(`A group named "${name}" already exists`);
      }
      throw err;
    }

    await recordAuditEvent({
      action: "role_group.created",
      entityId: group.id,
      entityType: "permission",
      after: { name, roles: input.roles },
      organizationId,
    });
    log.action(LogEvent.ROLE_GROUP_CREATED, { organizationId, groupName: name });

    return { id: group.id, name, description: input.description ?? "", roles: input.roles };
  };

  updateGroup = async (
    organizationId: string,
    groupId: string,
    input: { name?: string; description?: string; roles?: string[] },
  ) => {
    const [existing] = await db
      .select()
      .from(roleGroup)
      .where(and(eq(roleGroup.id, groupId), eq(roleGroup.organizationId, organizationId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Role group not found");

    const updateData: {
      name?: string;
      description?: string;
      roles?: string;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestError("Group name is required");
      updateData.name = name;
    }
    if (input.description !== undefined) updateData.description = input.description;
    if (input.roles !== undefined) updateData.roles = input.roles.join(",");

    const [updated] = await db
      .update(roleGroup)
      .set(updateData)
      .where(eq(roleGroup.id, groupId))
      .returning();

    await recordAuditEvent({
      action: "role_group.updated",
      entityId: groupId,
      entityType: "permission",
      after: {
        name: updated.name,
        roles: updated.roles ? updated.roles.split(",").map((r) => r.trim()).filter(Boolean) : [],
      },
      organizationId,
    });

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description ?? "",
      roles: updated.roles ? updated.roles.split(",").map((r) => r.trim()).filter(Boolean) : [],
    };
  };

  deleteGroup = async (organizationId: string, groupId: string) => {
    const [existing] = await db
      .select()
      .from(roleGroup)
      .where(and(eq(roleGroup.id, groupId), eq(roleGroup.organizationId, organizationId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Role group not found");

    await db.delete(roleGroupMember).where(eq(roleGroupMember.groupId, groupId));
    await db.delete(roleGroup).where(eq(roleGroup.id, groupId));

    await recordAuditEvent({
      action: "role_group.deleted",
      entityId: groupId,
      entityType: "permission",
      organizationId,
    });
    log.action(LogEvent.ROLE_GROUP_DELETED, { organizationId, groupName: existing.name });

    return { message: "Role group deleted" };
  };

  addMember = async (organizationId: string, groupId: string, memberId: string) => {
    const [existingGroup] = await db
      .select()
      .from(roleGroup)
      .where(and(eq(roleGroup.id, groupId), eq(roleGroup.organizationId, organizationId)))
      .limit(1);

    if (!existingGroup) throw new NotFoundError("Role group not found");

    const [existingMember] = await db
      .select()
      .from(member)
      .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)))
      .limit(1);

    if (!existingMember) throw new NotFoundError("Staff member not found");

    // Check if already a member
    const [alreadyMember] = await db
      .select()
      .from(roleGroupMember)
      .where(and(eq(roleGroupMember.groupId, groupId), eq(roleGroupMember.memberId, memberId)))
      .limit(1);

    if (alreadyMember) throw new BadRequestError("Staff member is already in this group");

    const [row] = await db
      .insert(roleGroupMember)
      .values({ groupId, memberId })
      .returning();

    await recordAuditEvent({
      action: "role_group.member_added",
      entityId: groupId,
      entityType: "permission",
      after: { memberId, groupName: existingGroup.name },
      organizationId,
    });

    return { id: row.id, groupId, memberId };
  };

  removeMember = async (organizationId: string, groupId: string, memberId: string) => {
    const [existingGroup] = await db
      .select()
      .from(roleGroup)
      .where(and(eq(roleGroup.id, groupId), eq(roleGroup.organizationId, organizationId)))
      .limit(1);

    if (!existingGroup) throw new NotFoundError("Role group not found");

    const [membership] = await db
      .select()
      .from(roleGroupMember)
      .where(and(eq(roleGroupMember.groupId, groupId), eq(roleGroupMember.memberId, memberId)))
      .limit(1);

    if (!membership) throw new NotFoundError("Staff member is not in this group");

    await db.delete(roleGroupMember).where(eq(roleGroupMember.id, membership.id));

    await recordAuditEvent({
      action: "role_group.member_removed",
      entityId: groupId,
      entityType: "permission",
      after: { memberId, groupName: existingGroup.name },
      organizationId,
    });

    return { message: "Member removed from group" };
  };

  /**
   * All role names a member inherits from their group memberships,
   * merged with their direct `member.role`. This is additive — groups
   * can only widen access.
   */
  getEffectiveRoles = async (
    memberUserId: string,
    organizationId: string,
  ): Promise<string[]> => {
    const [memberRow] = await db
      .select({ id: member.id, role: member.role })
      .from(member)
      .where(
        and(eq(member.userId, memberUserId), eq(member.organizationId, organizationId)),
      )
      .limit(1);

    if (!memberRow) return [];

    // Direct roles from member.role
    const directRoles = memberRow.role
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    // Groups this member belongs to
    const memberships = await db
      .select({ groupId: roleGroupMember.groupId })
      .from(roleGroupMember)
      .where(eq(roleGroupMember.memberId, memberRow.id));

    if (memberships.length === 0) return directRoles;

    const groupIds = memberships.map((m) => m.groupId);
    const groups = await db
      .select({ roles: roleGroup.roles })
      .from(roleGroup)
      .where(inArray(roleGroup.id, groupIds));

    const groupRoles = new Set<string>();
    for (const g of groups) {
      if (g.roles) {
        for (const r of g.roles.split(",").map((r) => r.trim()).filter(Boolean)) {
          groupRoles.add(r);
        }
      }
    }

    // Union of direct + group roles, deduplicated
    return Array.from(new Set([...directRoles, ...groupRoles]));
  };
}
