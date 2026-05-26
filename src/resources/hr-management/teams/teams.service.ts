import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { staff } from "../../../db/schema/staff";
import { teams } from "../../../db/schema/teams";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../errors/app-error";
import { CreateTeamBody, UpdateTeamBody } from "../../../types/hr.types";

const ELIGIBLE_LEAD_ROLES = ["senior_paralegal", "attorney"] as const;

export const getAllTeams = async (firmId: string) => {
  return db.select().from(teams).where(eq(teams.firmId, firmId));
};

export const getTeamById = async (id: string, firmId: string) => {
  const result = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, id), eq(teams.firmId, firmId)));
  return result[0] ?? null;
};

export const createTeam = async (body: CreateTeamBody & { firmId: string }) => {
  if (body.leadId) {
    const lead = await db
      .select()
      .from(staff)
      .where(and(eq(staff.id, body.leadId), eq(staff.firmId, body.firmId)));

    if (!lead[0]) {
      throw new NotFoundError("Team lead not found");
    }

    if (!ELIGIBLE_LEAD_ROLES.includes(lead[0].role as any)) {
      throw new BadRequestError(
        "Only Senior Paralegals and Attorneys can be team leads",
      );
    }
  }

  try {
    const [newTeam] = await db.insert(teams).values(body).returning();
    return newTeam;
  } catch (error: any) {
    if (error.code === "23505") {
      throw new ConflictError(`A team named "${body.name}" already exists`);
    }
    throw error;
  }
};

export const updateTeam = async (
  id: string,
  firmId: string,
  body: UpdateTeamBody,
) => {
  if (body.leadId) {
    const lead = await db
      .select()
      .from(staff)
      .where(and(eq(staff.id, body.leadId), eq(staff.firmId, firmId)));

    if (!lead[0]) {
      throw new NotFoundError("Team lead not found");
    }

    if (!ELIGIBLE_LEAD_ROLES.includes(lead[0].role as any)) {
      throw new BadRequestError(
        "Only Senior Paralegals and Attorneys can be team leads",
      );
    }
  }

  const [updated] = await db
    .update(teams)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(teams.id, id), eq(teams.firmId, firmId)))
    .returning();

  return updated ?? null;
};

export const deleteTeam = async (id: string, firmId: string) => {
  const [deleted] = await db
    .delete(teams)
    .where(and(eq(teams.id, id), eq(teams.firmId, firmId)))
    .returning();
  return deleted ?? null;
};

export const getEligibleLeads = async (firmId: string) => {
  return db
    .select()
    .from(staff)
    .where(and(eq(staff.firmId, firmId), eq(staff.role, "senior_paralegal")))
    .union(
      db
        .select()
        .from(staff)
        .where(and(eq(staff.firmId, firmId), eq(staff.role, "attorney"))),
    );
};
