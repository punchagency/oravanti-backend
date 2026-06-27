import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { staff } from "../../../db/schema/staff";
import { teams } from "../../../db/schema/teams";
import { CreateTeamBody, UpdateTeamBody } from "../../../types/hr.types";
import {
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
} from "../../../utils/error/app-error";

const ELIGIBLE_LEAD_ROLES = ["senior_paralegal", "attorney"] as const;

export class TeamsService {
  getAllTeams = async (organizationId: string) => {
    return db.select().from(teams).where(eq(teams.organizationId, organizationId));
  };

  getTeamById = async (id: string, organizationId: string) => {
    const result = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.organizationId, organizationId)));
    return result[0] ?? null;
  };

  createTeam = async (body: CreateTeamBody & { organizationId: string }) => {
    if (body.leadId) {
      const lead = await db
        .select()
        .from(staff)
        .where(and(eq(staff.id, body.leadId), eq(staff.organizationId, body.organizationId)));

      if (!lead[0]) {
        throw new NotFoundError("Team lead not found");
      }

      if (!ELIGIBLE_LEAD_ROLES.includes(lead[0].jobTitle as any)) {
        throw new BadRequestError(
          "Only Senior Paralegals and Attorneys can be team leads",
        );
      }
    }

    try {
      const [newTeam] = await db.insert(teams).values({ ...body, id: crypto.randomUUID() }).returning();
      return newTeam;
    } catch (error: any) {
      if (error.code === "23505") {
        throw new ConflictError(`A team named "${body.name}" already exists`);
      }
      throw new InternalServerError((error as Error).message);
    }
  };

  updateTeam = async (id: string, organizationId: string, body: UpdateTeamBody) => {
    if (body.leadId) {
      const lead = await db
        .select()
        .from(staff)
        .where(and(eq(staff.id, body.leadId), eq(staff.organizationId, organizationId)));

      if (!lead[0]) {
        throw new NotFoundError("Team lead not found");
      }

      if (!ELIGIBLE_LEAD_ROLES.includes(lead[0].jobTitle as any)) {
        throw new BadRequestError(
          "Only Senior Paralegals and Attorneys can be team leads",
        );
      }
    }

    const [updated] = await db
      .update(teams)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(teams.id, id), eq(teams.organizationId, organizationId)))
      .returning();

    return updated ?? null;
  };

  deleteTeam = async (id: string, organizationId: string) => {
    const [deleted] = await db
      .delete(teams)
      .where(and(eq(teams.id, id), eq(teams.organizationId, organizationId)))
      .returning();
    return deleted ?? null;
  };

  getEligibleLeads = async (organizationId: string) => {
    return db
      .select()
      .from(staff)
      .where(and(eq(staff.organizationId, organizationId), eq(staff.jobTitle, "senior_paralegal")))
      .union(
        db
          .select()
          .from(staff)
          .where(and(eq(staff.organizationId, organizationId), eq(staff.jobTitle, "attorney"))),
      );
  };
}
