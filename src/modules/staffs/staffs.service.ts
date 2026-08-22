import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  practiceAreaCaseTypes,
  practiceAreas,
  practiceAreaSubcategories,
  staff,
  staffPracticeAreaCaseTypes,
  team,
  teamMember,
} from "../../db/schema";
import { member, user } from "../../db/schema/auth-schema";
import { resolveAvatarUrl } from "../../utils/storage/avatar-url";
import { storageService } from "../../utils/storage/storage.service";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("staffs.service");

export interface UpdateOwnProfileParams {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  barNumber?: string;
}

export class StaffsService {
  async getOwnProfile(userId: string, organizationId: string) {
    const [row] = await db
      .select({
        id: staff.id,
        userId: staff.userId,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: user.email,
        orgEmail: staff.orgEmail,
        phone: staff.phone,
        role: member.role,
        staffRole: staff.role,
        memberId: member.id,
        status: staff.status,
        jobTitle: staff.jobTitle,
        barNumber: staff.barNumber,
        startDate: staff.startDate,
        maxCaseload: staff.maxCaseload,
        avatarUrl: staff.avatarUrl,
        createdAt: staff.createdAt,
        updatedAt: staff.updatedAt,
        practiceAreas: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(DISTINCT jsonb_build_object('id', ${practiceAreas.id}, 'name', ${practiceAreas.name}))
              FROM ${staffPracticeAreaCaseTypes}
              INNER JOIN ${practiceAreaCaseTypes} ON ${practiceAreaCaseTypes.id} = ${staffPracticeAreaCaseTypes.caseTypeId}
              INNER JOIN ${practiceAreaSubcategories} ON ${practiceAreaSubcategories.id} = ${practiceAreaCaseTypes.subcategoryId}
              INNER JOIN ${practiceAreas} ON ${practiceAreas.id} = ${practiceAreaSubcategories.practiceAreaId}
              WHERE ${staffPracticeAreaCaseTypes.staffId} = ${staff.id}
            ),
            '[]'::json
          )
        `,
        subcategories: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(DISTINCT jsonb_build_object('id', ${practiceAreaSubcategories.id}, 'name', ${practiceAreaSubcategories.name}))
              FROM ${staffPracticeAreaCaseTypes}
              INNER JOIN ${practiceAreaCaseTypes} ON ${practiceAreaCaseTypes.id} = ${staffPracticeAreaCaseTypes.caseTypeId}
              INNER JOIN ${practiceAreaSubcategories} ON ${practiceAreaSubcategories.id} = ${practiceAreaCaseTypes.subcategoryId}
              WHERE ${staffPracticeAreaCaseTypes.staffId} = ${staff.id}
            ),
            '[]'::json
          )
        `,
        caseTypes: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', ${staffPracticeAreaCaseTypes.caseTypeId}, 'name', ${practiceAreaCaseTypes.name}))
              FROM ${staffPracticeAreaCaseTypes}
              INNER JOIN ${practiceAreaCaseTypes} ON ${practiceAreaCaseTypes.id} = ${staffPracticeAreaCaseTypes.caseTypeId}
              WHERE ${staffPracticeAreaCaseTypes.staffId} = ${staff.id}
            ),
            '[]'::json
          )
        `,
        teams: sql<{ id: string; name: string }[]>`
          COALESCE(
            (
              SELECT json_agg(json_build_object('id', ${team.id}, 'name', ${team.name}) ORDER BY ${team.name})
              FROM ${teamMember}
              INNER JOIN ${team} ON ${team.id} = ${teamMember.teamId}
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
      .where(
        and(eq(staff.userId, userId), eq(staff.organizationId, organizationId)),
      )
      .limit(1);

    if (!row) return null;

    const avatarUrl = await resolveAvatarUrl(row.avatarUrl);

    return {
      id: row.id,
      userId: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      orgEmail: row.orgEmail,
      phone: row.phone,
      role: row.role ?? row.staffRole,
      memberId: row.memberId,
      status: row.status,
      jobTitle: row.jobTitle,
      barNumber: row.barNumber,
      startDate: row.startDate,
      maxCaseload: row.maxCaseload,
      avatarUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      practiceAreas: row.practiceAreas ?? [],
      subcategories: row.subcategories ?? [],
      caseTypes: row.caseTypes ?? [],
      teams: row.teams ?? [],
    };
  }

  async updateOwnProfile(
    userId: string,
    organizationId: string,
    params: UpdateOwnProfileParams,
  ) {
    await db
      .update(staff)
      .set({ ...params })
      .where(
        and(eq(staff.userId, userId), eq(staff.organizationId, organizationId)),
      );

    await recordAuditEvent({
      action: "admin.staff_updated",
      entityType: "staff",
      entityId: userId,
      summary: "Staff profile updated",
      after: params,
      onWriteFailure: "log",
    });

    log.action("staff.profile_updated", { staffId: userId });
  }

  async uploadAvatar(
    staffId: string,
    organizationId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const [staffRecord] = await db
      .select({ id: staff.id, avatarUrl: staff.avatarUrl })
      .from(staff)
      .where(
        and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)),
      )
      .limit(1);

    if (!staffRecord) return null;

    const ext = file.mimetype.split("/")[1] ?? "png";
    const key = `avatars/${staffRecord.id}.${ext}`;

    await storageService.upload({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    const avatarUrl = await storageService.getSignedDownloadUrl(key);

    // Persist the R2 key, not the signed URL — presigned URLs expire (1h) and
    // the browser fetches avatars directly from R2, so each read re-signs.
    await db
      .update(staff)
      .set({ avatarUrl: key })
      .where(eq(staff.id, staffRecord.id));

    await recordAuditEvent({
      action: "admin.staff_updated",
      entityType: "staff",
      entityId: staffRecord.id,
      summary: "Staff avatar updated",
      before: { avatarUrl: staffRecord.avatarUrl },
      after: { avatarUrl: key },
      onWriteFailure: "log",
    });

    log.action("staff.avatar_uploaded", { staffId: staffRecord.id });

    return { avatarUrl };
  }
}
