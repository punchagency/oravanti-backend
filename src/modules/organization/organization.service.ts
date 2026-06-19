import { symmetricEncrypt } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { auth } from "../../auth";
import { env } from "../../config/env";
import { db } from "../../db/client";
import {
  practiceAreas,
  staff,
  staffPracticeAreas,
  teamMembers,
  teams,
} from "../../db/schema";
import {
  invitation,
  member,
  organization,
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
        sql`(${staff.id}) IN (SELECT ${teamMembers.staffId} FROM ${teamMembers} INNER JOIN ${teams} ON ${teamMembers.teamId} = ${teams.id} WHERE ${teams.name} = ${team})`,
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
        team: sql<string>`
          COALESCE(
            (
              SELECT string_agg(${teams.name}, ', ' ORDER BY ${teams.name})
              FROM ${teamMembers}
              INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
              WHERE ${teamMembers.staffId} = ${staff.id}
            ),
            ''
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
      team: row.team,
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
          WHERE ${staff.id} IN (
            SELECT ${teamMembers.staffId} FROM ${teamMembers}
            INNER JOIN ${teams} ON ${teamMembers.teamId} = ${teams.id}
            WHERE ${teams.name} = ${team}
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
              SELECT string_agg(${teams.name}, ', ' ORDER BY ${teams.name})
              FROM ${teamMembers}
              INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
              WHERE ${teamMembers.staffId} = ${staff.id}
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
    const { practiceAreaIds, ...safeFields } = params;

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
      .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
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
}
