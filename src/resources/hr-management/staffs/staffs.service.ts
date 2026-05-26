import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { staff } from "../../../db/schema/staff";
import { teamMembers } from "../../../db/schema/team-members";
import { AddStaffBody, UpdateStaffBody } from "../../../types/hr.types";

export const getAllStaff = async (firmId: string) => {
  return db.select().from(staff).where(eq(staff.firmId, firmId));
};

export const getStaffById = async (id: string, firmId: string) => {
  const result = await db
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.firmId, firmId)));
  return result[0] ?? null;
};

export const getStaffByTeam = async (teamId: string, firmId: string) => {
  return db
    .select({ staff })
    .from(staff)
    .innerJoin(teamMembers, eq(teamMembers.staffId, staff.id))
    .where(and(eq(teamMembers.teamId, teamId), eq(staff.firmId, firmId)))
    .then((rows) => rows.map((r) => r.staff));
};

export const addStaff = async (body: AddStaffBody & { firmId: string }) => {
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

export const updateStaff = async (
  id: string,
  firmId: string,
  body: UpdateStaffBody,
) => {
  const [updated] = await db
    .update(staff)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(staff.id, id), eq(staff.firmId, firmId)))
    .returning();

  return updated ?? null;
};

export const deleteStaff = async (id: string, firmId: string) => {
  const [deleted] = await db
    .delete(staff)
    .where(and(eq(staff.id, id), eq(staff.firmId, firmId)))
    .returning();
  return deleted ?? null;
};

// ─── Team membership management ───────────────────────────────────────────────

export const addToTeam = async (staffId: string, teamId: string) => {
  const [row] = await db
    .insert(teamMembers)
    .values({ staffId, teamId })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
};

export const removeFromTeam = async (staffId: string, teamId: string) => {
  const [row] = await db
    .delete(teamMembers)
    .where(
      and(eq(teamMembers.staffId, staffId), eq(teamMembers.teamId, teamId)),
    )
    .returning();
  return row ?? null;
};

export const getTeamsForStaff = async (staffId: string) => {
  return db
    .select({ teamId: teamMembers.teamId, joinedAt: teamMembers.joinedAt })
    .from(teamMembers)
    .where(eq(teamMembers.staffId, staffId));
};
