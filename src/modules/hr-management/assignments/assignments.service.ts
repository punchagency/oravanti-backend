import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { assignments } from "../../../db/schema/assignments";
import { contractors } from "../../../db/schema/contractors";
import { AssignCaseBody, FilingType } from "../../../types/hr.types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../utils/error/app-error";

export class AssignmentsService {
  getAvailableContractors = async (_filingType: FilingType, _organizationId: string) => {
    return db
      .select()
      .from(contractors)
      .where(eq(contractors.status, "active"));
  };

  assignCase = async (body: AssignCaseBody & { organizationId: string }) => {
    const {
      assignmentType,
      filingType,
      urgencyLevel,
      teamId,
      contractorId,
      organizationId,
    } = body;

    if (assignmentType === "internal_team" && !teamId) {
      throw new BadRequestError(
        "teamId is required for internal team assignments",
      );
    }

    if (assignmentType === "external_contractor" && !contractorId) {
      throw new BadRequestError(
        "contractorId is required for external contractor assignments",
      );
    }

    if (assignmentType === "external_contractor" && contractorId) {
      const contractor = await db
        .select()
        .from(contractors)
        .where(eq(contractors.id, contractorId));

      if (!contractor[0]) {
        throw new NotFoundError("Contractor not found");
      }

      if (contractor[0].status !== "active") {
        throw new ConflictError("Contractor is not available");
      }
    }

    const [newAssignment] = await db
      .insert(assignments)
      .values({
        organizationId,
        assignmentType,
        filingType,
        urgencyLevel,
        teamId: assignmentType === "internal_team" ? teamId : null,
        contractorId:
          assignmentType === "external_contractor" ? contractorId : null,
        status: "pending",
      })
      .returning();

    return newAssignment;
  };

  getAllAssignments = async (organizationId: string) => {
    return db.select().from(assignments).where(eq(assignments.organizationId, organizationId));
  };

  getAssignmentById = async (id: string, organizationId: string) => {
    const result = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, id), eq(assignments.organizationId, organizationId)));
    return result[0] ?? null;
  };

  updateAssignmentStatus = async (
    id: string,
    organizationId: string,
    status: "pending" | "active" | "completed" | "cancelled",
  ) => {
    const [updated] = await db
      .update(assignments)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(assignments.id, id), eq(assignments.organizationId, organizationId)))
      .returning();

    return updated ?? null;
  };
}
