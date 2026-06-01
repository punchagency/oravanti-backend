import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { staff } from "../../../db/schema/staff";
import { teamMembers } from "../../../db/schema/team-members";
import { AddStaffBody, UpdateStaffBody } from "../../../types/hr.types";

export class StaffService {
  getAllStaff = async (organizationId: string) => {
    return db.select().from(staff).where(eq(staff.organizationId, organizationId));
  };

  getStaffById = async (id: string, organizationId: string) => {
    const result = await db
      .select()
      .from(staff)
      .where(and(eq(staff.id, id), eq(staff.organizationId, organizationId)));
    return result[0] ?? null;
  };

  getStaffByTeam = async (teamId: string, organizationId: string) => {
    return db
      .select({ staff })
      .from(staff)
      .innerJoin(teamMembers, eq(teamMembers.staffId, staff.id))
      .where(and(eq(teamMembers.teamId, teamId), eq(staff.organizationId, organizationId)))
      .then((rows) => rows.map((r) => r.staff));
  };

  addStaff = async (body: AddStaffBody & { organizationId: string }) => {
    const { teamId, ...staffData } = body;

    const [newStaff] = await db.insert(staff).values(staffData).returning();

    if (teamId) {
      await db
        .insert(teamMembers)
        .values({ teamId, staffId: newStaff.id })
        .onConflictDoNothing();
    }

    return newStaff;
  };

  updateStaff = async (id: string, organizationId: string, body: UpdateStaffBody) => {
    const [updated] = await db
      .update(staff)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(staff.id, id), eq(staff.organizationId, organizationId)))
      .returning();

    return updated ?? null;
  };

  deleteStaff = async (id: string, organizationId: string) => {
    const [deleted] = await db
      .delete(staff)
      .where(and(eq(staff.id, id), eq(staff.organizationId, organizationId)))
      .returning();
    return deleted ?? null;
  };

  // ─── Team membership management ───────────────────────────────────────────────

  addToTeam = async (staffId: string, teamId: string) => {
    const [row] = await db
      .insert(teamMembers)
      .values({ staffId, teamId })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  };

  removeFromTeam = async (staffId: string, teamId: string) => {
    const [row] = await db
      .delete(teamMembers)
      .where(
        and(eq(teamMembers.staffId, staffId), eq(teamMembers.teamId, teamId)),
      )
      .returning();
    return row ?? null;
  };

  getTeamsForStaff = async (staffId: string) => {
    return db
      .select({ teamId: teamMembers.teamId, joinedAt: teamMembers.joinedAt })
      .from(teamMembers)
      .where(eq(teamMembers.staffId, staffId));
  };
}
