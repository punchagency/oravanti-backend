import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { assignments } from "../../db/schema/assignments";
import { contractors } from "../../db/schema/contractors";
import { AssignCaseBody, FilingType } from "../../types/hr.types";

export const getAvailableContractors = async (
  filingType: FilingType,
  firmId: string,
) => {
  return db
    .select()
    .from(contractors)
    .where(
      and(
        eq(contractors.firmId, firmId),
        eq(contractors.specialization, filingType),
        eq(contractors.status, "active"),
      ),
    );
};

export const assignCase = async (body: AssignCaseBody & { firmId: string }) => {
  const {
    assignmentType,
    filingType,
    urgencyLevel,
    teamId,
    contractorId,
    firmId,
  } = body;

  if (assignmentType === "internal_team" && !teamId) {
    throw new Error("teamId is required for internal team assignments");
  }

  if (assignmentType === "external_contractor" && !contractorId) {
    throw new Error(
      "contractorId is required for external contractor assignments",
    );
  }

  if (assignmentType === "external_contractor" && contractorId) {
    const contractor = await db
      .select()
      .from(contractors)
      .where(
        and(eq(contractors.id, contractorId), eq(contractors.firmId, firmId)),
      );

    if (!contractor[0]) {
      throw new Error("Contractor not found");
    }

    if (contractor[0].status !== "active") {
      throw new Error("Contractor is not available");
    }
  }

  const [newAssignment] = await db
    .insert(assignments)
    .values({
      firmId,
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

export const getAllAssignments = async (firmId: string) => {
  return db.select().from(assignments).where(eq(assignments.firmId, firmId));
};

export const getAssignmentById = async (id: string, firmId: string) => {
  const result = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.id, id), eq(assignments.firmId, firmId)));
  return result[0] ?? null;
};

export const updateAssignmentStatus = async (
  id: string,
  firmId: string,
  status: "pending" | "active" | "completed" | "cancelled",
) => {
  const [updated] = await db
    .update(assignments)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(assignments.id, id), eq(assignments.firmId, firmId)))
    .returning();

  return updated ?? null;
};
