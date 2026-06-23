import { symmetricEncrypt } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import { aliasedTable, and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { auth } from "../../auth";
import { env } from "../../config/env";
import { db } from "../../db/client";
import {
  practiceAreas,
  staff,
  staffPracticeAreas,
  teamPracticeAreas,
} from "../../db/schema";
import {
  invitation,
  member,
  organization,
  teamMember,
  team as teamTable,
  user,
} from "../../db/schema/auth-schema";

export interface GetAllFilters {
  search?: string;
  role?: string;
  team?: string;
  status?: string;
  page?: number;
  limit?: number;
}

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let password = "";
  const bytes = randomBytes(12);
  for (let i = 0; i < bytes.length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

export interface InviteStaffParams {
  organizationId: string;
  firstName: string;
  lastName: string;
  email: string;
  orgEmail?: string;
  phone?: string;
  role?: string;
  startDate?: string;
  maxCaseload?: number;
  practiceAreaIds?: string[];
  teamIds?: string[];
}

export interface UpdateStaffParams {
  phone?: string;
  jobTitle?: string;
  maxCaseload?: number;
  startDate?: string;
  email?: string;
  orgEmail?: string;
  firstName?: string;
  lastName?: string;
  practiceAreaIds?: string[];
  teamIds?: string[];
}

export class OrganizationService {
  async getAll(organizationId: string, filters: GetAllFilters = {}) {
    const { search, role, team, status, page = 1, limit = 10 } = filters;
    const offset = (page - 1) * limit;

    // Build dynamic WHERE conditions from filter params
    const conditions: ReturnType<typeof sql>[] = [
      eq(staff.organizationId, organizationId),
    ];

    // Search: full-text tsvector/tsquery prefix matching on name, LIKE fallback on name + email
    if (search) {
      const searchTerms = search
        .trim()
        .split(/\s+/)
        .map((term) => `${term}:*`)
        .join(" & ");

      const tsQuery = sql`to_tsquery('english', ${searchTerms})`;

      const likeQuery = `%${search.toLowerCase()}%`;

      conditions.push(
        sql`(
          to_tsvector('english', coalesce(${staff.firstName}, '') || ' ' || coalesce(${staff.lastName}, '')) @@ ${tsQuery}
          OR LOWER(${staff.firstName}) LIKE ${likeQuery}
          OR LOWER(${staff.lastName}) LIKE ${likeQuery}
          OR LOWER(${user.email}) LIKE ${likeQuery}
          OR LOWER(${staff.email}) LIKE ${likeQuery}
        )`,
      );
    }

    // Role filter: check both member.role and staff.role (synced copy) via case-insensitive text comparison
    if (role && role !== "all-roles") {
      conditions.push(
        sql`(LOWER(${member.role}::text) = LOWER(${role}) OR LOWER(${staff.role}::text) = LOWER(${role}))`,
      );
    }

    // Team filter: subquery on team_members + teams junction
    if (team && team !== "all-teams") {
      conditions.push(
        sql`(${staff.userId}) IN (SELECT ${teamMember.userId} FROM ${teamMember} INNER JOIN ${teamTable} ON ${teamMember.teamId} = ${teamTable.id} WHERE ${teamTable.name} = ${team})`,
      );
    }

    // Status filter: direct enum match
    if (status && status !== "all-statuses") {
      conditions.push(sql`${staff.status} = ${status}`);
    }

    // Total count (before pagination) for pagination metadata
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(staff)
      .leftJoin(user, eq(staff.userId, user.id))
      .leftJoin(
        member,
        and(
          eq(member.userId, staff.userId),
          eq(member.organizationId, staff.organizationId),
        ),
      )
      .where(and(...conditions));

    const total = Number(count);

    // Main paginated query with LEFT JOINs to user and member tables
    // Practice areas and team are fetched via correlated subqueries (json_agg / string_agg)
    const rows = await db
      .select({
        id: staff.id,
        userId: staff.userId,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: user.email,
        staffEmail: staff.email,
        orgEmail: staff.orgEmail,
        phone: staff.phone,
        role: member.role,
        memberId: member.id,
        staffRole: staff.role,
        status: staff.status,
        jobTitle: staff.jobTitle,
        startDate: staff.startDate,
        maxCaseload: staff.maxCaseload,
        createdAt: staff.createdAt,
        updatedAt: staff.updatedAt,
        practiceAreas: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', ${staffPracticeAreas.practiceAreaId}, 'name', ${practiceAreas.name}))
              FROM ${staffPracticeAreas}
              INNER JOIN ${practiceAreas} ON ${practiceAreas.id} = ${staffPracticeAreas.practiceAreaId}
              WHERE ${staffPracticeAreas.staffId} = ${staff.id}
            ),
            '[]'::json
          )
        `,
        teams: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', ${teamTable.id}, 'name', ${teamTable.name}) ORDER BY ${teamTable.name})
              FROM ${teamMember}
              INNER JOIN ${teamTable} ON ${teamTable.id} = ${teamMember.teamId}
              WHERE ${teamMember.userId} = ${staff.userId}
            ),
            '[]'::json
          )
        `,
      })
      .from(staff)
      .leftJoin(user, eq(staff.userId, user.id))
      .leftJoin(
        member,
        and(
          eq(member.userId, staff.userId),
          eq(member.organizationId, staff.organizationId),
        ),
      )
      .where(and(...conditions))
      .orderBy(staff.createdAt)
      .limit(limit)
      .offset(offset);

    // Assemble final response rows: coalesce auth email/role with staff fallback
    const data = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email ?? row.staffEmail,
      orgEmail: row.orgEmail,
      phone: row.phone,
      role: row.role ?? row.staffRole,
      memberId: row.memberId,
      status: row.status,
      jobTitle: row.jobTitle,
      startDate: row.startDate,
      maxCaseload: row.maxCaseload,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      practiceAreas: row.practiceAreas ?? [],
      teams: row.teams,
    }));

    // Unfiltered status counts for the summary bar (computed from all staff in org, ignoring filters)
    const counts = await this.getCounts(organizationId);

    return { data, counts, pagination: { total, limit, offset } };
  }

  async getCounts(organizationId: string) {
    const [result] = await db
      .select({
        active: sql<number>`COUNT(*) FILTER (WHERE ${staff.status} = 'active')::int`,
        onLeave: sql<number>`COUNT(*) FILTER (WHERE ${staff.status} = 'on_leave')::int`,
        recertifyRequired: sql<number>`COUNT(*) FILTER (WHERE ${staff.status} = 'recertify_required')::int`,
        pendingInvitation: sql<number>`COUNT(*) FILTER (WHERE ${staff.status} = 'pending_invitation')::int`,
      })
      .from(staff)
      .where(eq(staff.organizationId, organizationId));

    return result;
  }

  async acceptInvite(
    invitationId: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const data = await auth.api.acceptInvitation({
      body: { invitationId },
      headers: fromNodeHeaders(headers as Record<string, string>),
    });
    return data;
  }

  async listInvitations(
    organizationId: string,
    filters: {
      search?: string;
      role?: string;
      team?: string;
      status?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const { search, role, team, status, page = 1, limit = 10 } = filters;
    const offset = (page - 1) * limit;

    const conditions: ReturnType<typeof sql>[] = [
      eq(invitation.organizationId, organizationId),
    ];

    if (status && status !== "all-statuses") {
      conditions.push(eq(invitation.status, status));
    }

    if (role && role !== "all-roles") {
      conditions.push(sql`LOWER(${invitation.role}::text) = LOWER(${role})`);
    }

    if (search) {
      const likeQuery = `%${search.toLowerCase()}%`;
      conditions.push(
        sql`(
          LOWER(${invitation.email}) LIKE ${likeQuery}
          OR LOWER(${staff.firstName}) LIKE ${likeQuery}
          OR LOWER(${staff.lastName}) LIKE ${likeQuery}
        )`,
      );
    }

    if (team && team !== "all-teams") {
      conditions.push(
        sql`(${invitation.email}) IN (
          SELECT ${staff.email} FROM ${staff}
          WHERE ${staff.userId} IN (
            SELECT ${teamMember.userId} FROM ${teamMember}
            INNER JOIN ${teamTable} ON ${teamMember.teamId} = ${teamTable.id}
            WHERE ${teamTable.name} = ${team}
          )
        )`,
      );
    }

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(invitation)
      .leftJoin(
        staff,
        and(
          sql`LOWER(${staff.email}) = LOWER(${invitation.email})`,
          eq(staff.organizationId, organizationId),
        ),
      )
      .where(and(...conditions));

    const total = Number(count);

    const rows = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        organizationId: invitation.organizationId,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterId: invitation.inviterId,
        firstName: staff.firstName,
        lastName: staff.lastName,
        invitedBy: user.name,
        invitedByEmail: user.email,
        practiceAreas: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', ${staffPracticeAreas.practiceAreaId}, 'name', ${practiceAreas.name}))
              FROM ${staffPracticeAreas}
              INNER JOIN ${practiceAreas} ON ${practiceAreas.id} = ${staffPracticeAreas.practiceAreaId}
              WHERE ${staffPracticeAreas.staffId} = ${staff.id}
            ),
            '[]'::json
          )
        `,
        team: sql<string>`
          COALESCE(
            (
              SELECT string_agg(${teamTable.name}, ', ' ORDER BY ${teamTable.name})
              FROM ${teamMember}
              INNER JOIN ${teamTable} ON ${teamTable.id} = ${teamMember.teamId}
              WHERE ${teamMember.userId} = ${staff.userId}
            ),
            ''
          )
        `,
      })
      .from(invitation)
      .leftJoin(
        staff,
        and(
          sql`LOWER(${staff.email}) = LOWER(${invitation.email})`,
          eq(staff.organizationId, organizationId),
        ),
      )
      .leftJoin(user, eq(user.id, invitation.inviterId))
      .where(and(...conditions))
      .orderBy(desc(invitation.createdAt))
      .limit(limit)
      .offset(offset);

    const data = rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      organizationId: row.organizationId,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      inviterId: row.inviterId,
      firstName: row.firstName,
      lastName: row.lastName,
      invitedBy: row.invitedBy,
      invitedByEmail: row.invitedByEmail,
      practiceAreas: row.practiceAreas ?? [],
      team: row.team ?? "",
    }));

    const [countsRow] = await db
      .select({
        pending: sql<number>`COUNT(*) FILTER (WHERE ${invitation.status} = 'pending')::int`,
        accepted: sql<number>`COUNT(*) FILTER (WHERE ${invitation.status} = 'accepted')::int`,
        rejected: sql<number>`COUNT(*) FILTER (WHERE ${invitation.status} = 'rejected')::int`,
        canceled: sql<number>`COUNT(*) FILTER (WHERE ${invitation.status} = 'canceled')::int`,
      })
      .from(invitation)
      .where(eq(invitation.organizationId, organizationId));

    return {
      data,
      counts: countsRow,
      pagination: { total, limit, offset },
    };
  }

  async resendInvitation(
    email: string,
    role: string,
    organizationId: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const result = await auth.api.createInvitation({
      body: {
        email,
        role: role as "admin" | "attorney" | "paralegal",
        organizationId,
        resend: true,
      },
      headers: fromNodeHeaders(headers as Record<string, string>),
    });

    return result;
  }

  async cancelInvite(
    invitationId: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const cancelled = await auth.api.cancelInvitation({
      body: { invitationId },
      headers: fromNodeHeaders(headers as Record<string, string>),
    });

    const email = cancelled?.email;
    if (email) {
      const [staffRecord] = await db
        .select({ id: staff.id, userId: staff.userId })
        .from(staff)
        .where(eq(staff.email, email))
        .limit(1);

      if (staffRecord?.userId) {
        const userId = staffRecord.userId;
        await db.transaction(async (tx) => {
          await tx.delete(staff).where(eq(staff.id, staffRecord.id));
          await tx.delete(user).where(eq(user.id, userId));
        });
      }
    }

    return cancelled;
  }

  async updateStaff(
    staffId: string,
    organizationId: string,
    params: UpdateStaffParams,
  ) {
    const { practiceAreaIds, teamIds, ...safeFields } = params;

    const updateData: Record<string, unknown> = {
      ...safeFields,
      updatedAt: new Date(),
    };

    if (updateData.startDate) {
      updateData.startDate = new Date(updateData.startDate as string);
    }

    if (updateData.maxCaseload !== undefined) {
      updateData.maxCaseload = Number(updateData.maxCaseload);
    }

    await db.transaction(async (tx) => {
      const needsUserLookup =
        safeFields.email || safeFields.firstName || safeFields.lastName;
      let userId: string | undefined;

      if (needsUserLookup) {
        const [existingStaff] = await tx
          .select({ userId: staff.userId })
          .from(staff)
          .where(eq(staff.id, staffId))
          .limit(1);

        userId = existingStaff?.userId ?? undefined;
      }

      // If personal email is being updated, sync user.email and staff.email
      if (userId && safeFields.email) {
        await tx
          .update(user)
          .set({ email: safeFields.email as string, updatedAt: new Date() })
          .where(eq(user.id, userId));

        updateData.email = safeFields.email;
      }

      // If first or last name is being updated, sync user.name
      if (userId && (safeFields.firstName || safeFields.lastName)) {
        const [currentStaff] = await tx
          .select({ firstName: staff.firstName, lastName: staff.lastName })
          .from(staff)
          .where(eq(staff.id, staffId))
          .limit(1);

        const newName = [
          safeFields.firstName ?? currentStaff.firstName,
          safeFields.lastName ?? currentStaff.lastName,
        ].join(" ");

        await tx
          .update(user)
          .set({ name: newName, updatedAt: new Date() })
          .where(eq(user.id, userId));
      }

      await tx
        .update(staff)
        .set(updateData)
        .where(
          and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)),
        );

      if (practiceAreaIds !== undefined) {
        await tx
          .delete(staffPracticeAreas)
          .where(eq(staffPracticeAreas.staffId, staffId));

        if (practiceAreaIds.length > 0) {
          await tx.insert(staffPracticeAreas).values(
            practiceAreaIds.map((practiceAreaId) => ({
              staffId,
              practiceAreaId,
            })),
          );
        }
      }

      if (teamIds !== undefined) {
        const [existingStaff] = await tx
          .select({ userId: staff.userId })
          .from(staff)
          .where(eq(staff.id, staffId))
          .limit(1);

        const currentUserId = existingStaff?.userId;
        if (currentUserId) {
          await tx
            .delete(teamMember)
            .where(eq(teamMember.userId, currentUserId));

          if (teamIds.length > 0) {
            await tx.insert(teamMember).values(
              teamIds.map((teamId) => ({
                id: randomUUID(),
                teamId,
                userId: currentUserId,
                createdAt: new Date(),
              })),
            );
          }
        }
      }
    });

    return { message: "Staff updated successfully" };
  }

  async updateStaffRole(
    staffId: string,
    organizationId: string,
    role: string,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const [staffRecord] = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(
        and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)),
      )
      .limit(1);

    if (!staffRecord?.userId) {
      throw new Error("Staff member not found or not linked to a user");
    }

    const [memberRecord] = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.userId, staffRecord.userId),
          eq(member.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!memberRecord) {
      throw new Error("Member record not found");
    }

    await auth.api.updateMemberRole({
      body: { memberId: memberRecord.id, role },
      headers: fromNodeHeaders(headers as Record<string, string>),
    });

    return { message: "Role updated successfully" };
  }

  async getMyPendingInvitation(userId: string) {
    const [userRecord] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!userRecord?.email) return null;

    const [pending] = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        organizationId: invitation.organizationId,
        organizationName: organization.name,
        inviterId: invitation.inviterId,
        inviterName: user.name,
        inviterEmail: user.email,
      })
      .from(invitation)
      .innerJoin(organization, eq(invitation.organizationId, organization.id))
      .innerJoin(user, eq(invitation.inviterId, user.id))
      .where(
        and(
          eq(invitation.email, userRecord.email),
          eq(invitation.status, "pending"),
        ),
      )
      .limit(1);

    return pending || null;
  }

  async needsSetup(userId: string) {
    const [userRecord] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const [pendingResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(invitation)
      .where(
        and(
          eq(invitation.email, userRecord?.email ?? ""),
          eq(invitation.status, "pending"),
        ),
      );

    const needsAcceptInvitation = (pendingResult?.count ?? 0) > 0;

    const [staffRecord] = await db
      .select({ tempPassword: staff.tempPassword })
      .from(staff)
      .where(eq(staff.userId, userId))
      .limit(1);

    const needsPasswordChange = !!staffRecord?.tempPassword;

    return { needsAcceptInvitation, needsPasswordChange };
  }

  async setPassword(
    userId: string,
    params: { currentPassword: string; newPassword: string },
    headers: Record<string, string | string[] | undefined>,
  ) {
    const response = await auth.api.changePassword({
      headers: fromNodeHeaders(headers as Record<string, string>),
      body: {
        currentPassword: params.currentPassword,
        newPassword: params.newPassword,
        revokeOtherSessions: true,
      },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || "Password change failed");
    }

    // Clear temp password so user can proceed to dashboard
    await db
      .update(staff)
      .set({ tempPassword: null })
      .where(eq(staff.userId, userId));

    return { message: "Password set successfully" };
  }

  async listTeams(
    organizationId: string,
    filters: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const { search, status, page = 1, limit = 10 } = filters;
    const offset = (page - 1) * limit;

    const conditions: ReturnType<typeof sql>[] = [
      eq(teamTable.organizationId, organizationId),
    ];

    if (search) {
      const likeQuery = `%${search.toLowerCase()}%`;
      conditions.push(sql`LOWER(${teamTable.name}) LIKE ${likeQuery}`);
    }

    if (status && status !== "all-statuses") {
      conditions.push(sql`${teamTable.status} = ${status}`);
    }

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(teamTable)
      .where(and(...conditions));

    const total = Number(count);

    const leadStaff = aliasedTable(staff, "leadStaff");

    const rows = await db
      .select({
        id: teamTable.id,
        name: teamTable.name,
        description: teamTable.description,
        leadId: teamTable.leadId,
        leadName: sql<string | null>`
          CASE WHEN ${leadStaff.id} IS NOT NULL
            THEN ${leadStaff.firstName} || ' ' || ${leadStaff.lastName}
          END
        `,
        leadRole: leadStaff.role,
        maxCaseload: teamTable.maxCaseload,
        workloadPercentage: teamTable.workloadPercentage,
        status: teamTable.status,
        activeCases: teamTable.activeCases,
        memberCount: sql<number>`
          COALESCE(
            (SELECT COUNT(*) FROM ${teamMember} WHERE ${teamMember.teamId} = ${teamTable.id}),
            0
          )::int
        `,
        createdAt: teamTable.createdAt,
      })
      .from(teamTable)
      .leftJoin(leadStaff, sql`${leadStaff.id}::text = ${teamTable.leadId}`)
      .where(and(...conditions))
      .orderBy(desc(teamTable.createdAt))
      .limit(limit)
      .offset(offset);

    const data = rows;

    const counts = await this.getTeamCounts(organizationId);

    return { data, counts, pagination: { total, limit, offset } };
  }

  async getTeamCounts(organizationId: string) {
    const [result] = await db
      .select({
        totalTeams: sql<number>`COUNT(*)::int`,
        atCapacity: sql<number>`COUNT(*) FILTER (WHERE ${teamTable.workloadPercentage} > 80)::int`,
      })
      .from(teamTable)
      .where(eq(teamTable.organizationId, organizationId));

    const [activeMembersResult] = await db
      .select({
        activeMembers: sql<number>`COUNT(DISTINCT ${staff.id})::int`,
      })
      .from(teamMember)
      .innerJoin(teamTable, eq(teamTable.id, teamMember.teamId))
      .innerJoin(staff, eq(staff.userId, teamMember.userId))
      .where(eq(teamTable.organizationId, organizationId));

    const [practiceAreasResult] = await db
      .select({
        practiceAreasCovered: sql<number>`COUNT(DISTINCT ${staffPracticeAreas.practiceAreaId})::int`,
      })
      .from(staffPracticeAreas)
      .innerJoin(staff, eq(staff.id, staffPracticeAreas.staffId))
      .innerJoin(teamMember, eq(teamMember.userId, staff.userId))
      .innerJoin(teamTable, eq(teamTable.id, teamMember.teamId))
      .where(eq(teamTable.organizationId, organizationId));

    return {
      totalTeams: result.totalTeams,
      activeMembers: activeMembersResult.activeMembers,
      atCapacity: result.atCapacity,
      practiceAreasCovered: practiceAreasResult.practiceAreasCovered,
    };
  }

  async getTeam(teamId: string, organizationId: string) {
    const leadStaff = aliasedTable(staff, "leadStaff");

    const [row] = await db
      .select({
        id: teamTable.id,
        name: teamTable.name,
        description: teamTable.description,
        leadId: teamTable.leadId,
        leadName: sql<string | null>`
          CASE WHEN ${leadStaff.id} IS NOT NULL
            THEN ${leadStaff.firstName} || ' ' || ${leadStaff.lastName}
          END
        `,
        leadRole: leadStaff.role,
        maxCaseload: teamTable.maxCaseload,
        workloadPercentage: teamTable.workloadPercentage,
        status: teamTable.status,
        activeCases: teamTable.activeCases,
        memberCount: sql<number>`
          COALESCE(
            (SELECT COUNT(*) FROM ${teamMember} WHERE ${teamMember.teamId} = ${teamTable.id}),
            0
          )::int
        `,
        practiceAreas: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(DISTINCT jsonb_build_object('id', ${practiceAreas.id}, 'name', ${practiceAreas.name}))
              FROM ${teamPracticeAreas}
              INNER JOIN ${practiceAreas} ON ${practiceAreas.id} = ${teamPracticeAreas.practiceAreaId}
              WHERE ${teamPracticeAreas.teamId} = ${teamTable.id}
            ),
            '[]'::json
          )
        `,
        members: sql<
          {
            id: string;
            firstName: string;
            lastName: string;
            role: string | null;
            status: string;
          }[]
        >`
          COALESCE(
            (
              SELECT json_agg(json_build_object(
                'id', ${staff.id},
                'firstName', ${staff.firstName},
                'lastName', ${staff.lastName},
                'role', ${staff.role},
                'status', ${staff.status}
              ))
              FROM ${teamMember}
              INNER JOIN ${staff} ON ${staff.userId} = ${teamMember.userId}
              WHERE ${teamMember.teamId} = ${teamTable.id}
            ),
            '[]'::json
          )
        `,
        createdAt: teamTable.createdAt,
      })
      .from(teamTable)
      .leftJoin(leadStaff, sql`${leadStaff.id}::text = ${teamTable.leadId}`)
      .where(
        and(
          eq(teamTable.id, teamId),
          eq(teamTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      ...row,
      practiceAreas: row.practiceAreas ?? [],
      members: row.members ?? [],
    };
  }

  async createTeam(
    organizationId: string,
    params: {
      name: string;
      description?: string;
      leadId?: string;
      maxCaseload?: number;
      practiceAreaIds?: string[];
      memberStaffIds?: string[];
    },
    headers: Record<string, string | string[] | undefined>,
  ) {
    console.log({ params });

    const createdTeam = await auth.api.createTeam({
      body: {
        name: params.name.trim(),
        organizationId,
        leadId: params.leadId,
        description: params.description?.trim(),
        maxCaseload: params.maxCaseload,
        workloadPercentage: 0,
        status: "available",
        activeCases: 0,
      },
      headers: fromNodeHeaders(headers),
    });

    try {
      await db.transaction(async (tx) => {
        if (params.practiceAreaIds?.length) {
          await tx.insert(teamPracticeAreas).values(
            params.practiceAreaIds.map((practiceAreaId) => ({
              teamId: createdTeam.id,
              practiceAreaId,
            })),
          );
        }

        const allUserIds: string[] = [];

        if (params.leadId) {
          const [leadStaff] = await tx
            .select({ userId: staff.userId })
            .from(staff)
            .where(eq(staff.id, params.leadId))
            .limit(1);

          if (leadStaff?.userId) {
            allUserIds.push(leadStaff.userId);
          }
        }

        if (params.memberStaffIds?.length) {
          const memberUsers = await tx
            .select({ userId: staff.userId })
            .from(staff)
            .where(inArray(staff.id, params.memberStaffIds));

          for (const mu of memberUsers) {
            if (mu.userId && !allUserIds.includes(mu.userId)) {
              allUserIds.push(mu.userId);
            }
          }
        }

        for (const userId of allUserIds) {
          await tx.insert(teamMember).values({
            id: randomUUID(),
            teamId: createdTeam.id,
            userId,
            createdAt: new Date(),
          });
        }
      });
    } catch {
      await auth.api.removeTeam({
        body: { teamId: createdTeam.id },
        headers: fromNodeHeaders(headers),
      });
      await db.delete(teamTable).where(eq(teamTable.id, createdTeam.id));
      throw new Error(
        "Failed to complete team creation. All changes have been rolled back.",
      );
    }

    return createdTeam;
  }

  async invite(
    params: InviteStaffParams,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const {
      organizationId,
      firstName,
      lastName,
      email,
      orgEmail,
      phone,
      role,
      startDate,
      maxCaseload,
      practiceAreaIds,
      teamIds,
    } = params;

    const formattedEmail = email.toLowerCase().trim();
    const tempPassword = generateTempPassword();

    const { user: createdUser } = await auth.api.signUpEmail({
      body: {
        name: `${firstName} ${lastName}`,
        email: formattedEmail,
        password: tempPassword,
      },
    });

    let staffId!: string;

    const encryptedPassword = await symmetricEncrypt({
      key: env.BETTER_AUTH_SECRET,
      data: tempPassword,
    });

    await db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({
          emailVerified: true,
          onboardingState: "completed",
          accountType: "staff",
          tosAccepted: true,
          tosAcceptedAt: new Date(),
        })
        .where(eq(user.id, createdUser.id));

      const [created] = await tx
        .insert(staff)
        .values({
          organizationId,
          userId: createdUser.id,
          firstName,
          lastName,
          phone: phone ?? "",
          startDate: startDate ? new Date(startDate) : undefined,
          email: formattedEmail,
          role: role as "admin" | "attorney" | "paralegal",
          status: "pending_invitation",
          orgEmail: orgEmail?.toLowerCase().trim() ?? formattedEmail,
          maxCaseload: maxCaseload ?? 7,
          tempPassword: encryptedPassword,
        })
        .returning({ id: staff.id });

      staffId = created.id;

      if (practiceAreaIds?.length) {
        await tx.insert(staffPracticeAreas).values(
          practiceAreaIds.map((practiceAreaId) => ({
            staffId: created.id,
            practiceAreaId,
          })),
        );
      }

      if (teamIds?.length) {
        await tx.insert(teamMember).values(
          teamIds.map((teamId) => ({
            id: randomUUID(),
            teamId,
            userId: createdUser.id,
            createdAt: new Date(),
          })),
        );
      }
    });

    try {
      const createdInvitation = await auth.api.createInvitation({
        body: {
          organizationId,
          email: formattedEmail,
          role: role as "admin" | "attorney" | "paralegal",
          resend: true,
        },
        headers: fromNodeHeaders(headers as Record<string, string>),
      });

      return {
        staffId,
        invitationId: createdInvitation?.id,
      };
    } catch (e) {
      console.log({ error: e });

      await db.transaction(async (tx) => {
        await tx.delete(staff).where(eq(staff.id, staffId));
        await tx.delete(user).where(eq(user.id, createdUser.id));
      });

      throw e;
    }
  }

  async deleteTeam(teamId: string, organizationId: string) {
    const [existingTeam] = await db
      .select({ id: teamTable.id })
      .from(teamTable)
      .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)));

    if (!existingTeam) {
      throw new Error("Team not found");
    }

    await db.delete(teamTable).where(eq(teamTable.id, teamId));
  }

  async removeTeamMember(
    teamId: string,
    staffId: string,
    organizationId: string,
  ) {
    const staffMember = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
      .then((rows) => rows[0]);

    if (!staffMember || !staffMember.userId) {
      throw new Error("Staff member not found");
    }

    await db.delete(teamMember).where(
      and(eq(teamMember.teamId, teamId), eq(teamMember.userId, staffMember.userId)),
    );

    await db
      .update(teamTable)
      .set({ leadId: null })
      .where(and(eq(teamTable.id, teamId), eq(teamTable.leadId, staffId)));
  }

  async deleteStaff(staffId: string, organizationId: string) {
    const [staffMember] = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)));

    if (!staffMember) {
      throw new Error("Staff member not found");
    }

    if (staffMember.userId) {
      await db.delete(teamMember).where(eq(teamMember.userId, staffMember.userId));
    }

    await db
      .update(teamTable)
      .set({ leadId: null })
      .where(eq(teamTable.leadId, staffId));

    await db.delete(staff).where(eq(staff.id, staffId));
  }

  async updateTeam(
    teamId: string,
    organizationId: string,
    params: {
      name?: string;
      description?: string;
      maxCaseload?: number;
      leadId?: string | null;
      practiceAreaIds?: string[];
    },
  ) {
    const [existing] = await db
      .select({ id: teamTable.id })
      .from(teamTable)
      .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)));

    if (!existing) {
      throw new Error("Team not found");
    }

    if (params.name !== undefined || params.description !== undefined || params.maxCaseload !== undefined || params.leadId !== undefined) {
      await db
        .update(teamTable)
        .set({
          ...(params.name !== undefined && { name: params.name }),
          ...(params.description !== undefined && { description: params.description }),
          ...(params.maxCaseload !== undefined && { maxCaseload: params.maxCaseload }),
          ...(params.leadId !== undefined && { leadId: params.leadId }),
        })
        .where(eq(teamTable.id, teamId));
    }

    if (params.practiceAreaIds !== undefined) {
      await db.delete(teamPracticeAreas).where(eq(teamPracticeAreas.teamId, teamId));
      if (params.practiceAreaIds.length > 0) {
        await db.insert(teamPracticeAreas).values(
          params.practiceAreaIds.map((practiceAreaId) => ({
            teamId,
            practiceAreaId,
          })),
        );
      }
    }
  }

  async addTeamMembers(
    teamId: string,
    organizationId: string,
    staffIds: string[],
  ) {
    const [existing] = await db
      .select({ id: teamTable.id })
      .from(teamTable)
      .where(and(eq(teamTable.id, teamId), eq(teamTable.organizationId, organizationId)));

    if (!existing) {
      throw new Error("Team not found");
    }

    const staffMembers = await db
      .select({ id: staff.id, userId: staff.userId })
      .from(staff)
      .where(and(inArray(staff.id, staffIds), eq(staff.organizationId, organizationId)));

    const existingMembers = await db
      .select({ userId: teamMember.userId })
      .from(teamMember)
      .where(eq(teamMember.teamId, teamId));

    const existingUserIds = new Set(existingMembers.map((m) => m.userId));

    for (const s of staffMembers) {
      if (s.userId && !existingUserIds.has(s.userId)) {
        await db.insert(teamMember).values({
          id: randomUUID(),
          teamId,
          userId: s.userId,
          createdAt: new Date(),
        });
      }
    }
  }
}
