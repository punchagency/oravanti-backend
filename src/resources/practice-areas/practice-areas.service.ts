import { and, asc, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";

const normalizeName = (name: string) => name.trim();

const assertNameIsValid = (name?: string) => {
  if (!name || !normalizeName(name)) {
    throw new BadRequestError("name is required");
  }
};

const ensureNameIsAvailable = async (
  firmId: string,
  name: string,
  excludeId?: string,
) => {
  const matches = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(
      and(eq(practiceAreas.firmId, firmId), ilike(practiceAreas.name, name)),
    );

  const duplicate = matches.find((row) => row.id !== excludeId);
  if (duplicate) {
    throw new ConflictError("A practice area with this name already exists");
  }
};

export const getAllPracticeAreas = async (
  firmId: string,
  filters?: { search?: string },
) => {
  return db
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
      createdAt: practiceAreas.createdAt,
      updatedAt: practiceAreas.updatedAt,
    })
    .from(practiceAreas)
    .where(
      filters?.search
        ? and(
            eq(practiceAreas.firmId, firmId),
            ilike(practiceAreas.name, `%${filters.search}%`),
          )
        : eq(practiceAreas.firmId, firmId),
    )
    .orderBy(asc(practiceAreas.name));
};

export const getPracticeAreaById = async (id: string, firmId: string) => {
  const [practiceArea] = await db
    .select()
    .from(practiceAreas)
    .where(and(eq(practiceAreas.id, id), eq(practiceAreas.firmId, firmId)));

  if (!practiceArea) return null;

  const areaCases = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      caseType: cases.caseType,
      status: cases.status,
      priority: cases.priority,
      filingDate: cases.filingDate,
      caseProgress: cases.caseProgress,
      clientId: clients.id,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      assigneeFirstName: staff.firstName,
      assigneeLastName: staff.lastName,
      assigneeRole: staff.role,
    })
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(and(eq(cases.practiceAreaId, id), eq(cases.firmId, firmId)))
    .orderBy(desc(cases.createdAt));

  return {
    ...practiceArea,
    cases: areaCases.map((row) => ({
      id: row.id,
      caseNumber: row.caseNumber,
      caseType: row.caseType,
      status: row.status,
      priority: row.priority,
      filingDate: row.filingDate,
      caseProgress: row.caseProgress,
      client: {
        id: row.clientId,
        name: `${row.clientFirstName} ${row.clientLastName}`,
      },
      assignee: row.assigneeFirstName
        ? {
            name: `${row.assigneeFirstName} ${row.assigneeLastName}`,
            role: row.assigneeRole,
          }
        : null,
    })),
  };
};

export const createPracticeArea = async (
  firmId: string,
  data: { name: string },
) => {
  assertNameIsValid(data.name);
  const name = normalizeName(data.name);
  await ensureNameIsAvailable(firmId, name);

  const [practiceArea] = await db
    .insert(practiceAreas)
    .values({ firmId, name })
    .returning();

  return practiceArea;
};

export const updatePracticeArea = async (
  id: string,
  firmId: string,
  data: { name?: string },
) => {
  const [existing] = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(and(eq(practiceAreas.id, id), eq(practiceAreas.firmId, firmId)));

  if (!existing) return null;

  const updateData: Partial<typeof practiceAreas.$inferInsert> = {};
  if (data.name !== undefined) {
    assertNameIsValid(data.name);
    updateData.name = normalizeName(data.name);
    await ensureNameIsAvailable(firmId, updateData.name, id);
  }

  const [updated] = await db
    .update(practiceAreas)
    .set({ ...updateData, updatedAt: new Date() })
    .where(and(eq(practiceAreas.id, id), eq(practiceAreas.firmId, firmId)))
    .returning();

  return updated;
};

export const deletePracticeArea = async (id: string, firmId: string) => {
  const [existing] = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(and(eq(practiceAreas.id, id), eq(practiceAreas.firmId, firmId)));

  if (!existing) {
    throw new NotFoundError("Practice area not found");
  }

  const [caseUsingArea] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(and(eq(cases.practiceAreaId, id), eq(cases.firmId, firmId)))
    .limit(1);

  if (caseUsingArea) {
    throw new ConflictError("Cannot delete a practice area that has cases");
  }

  await db
    .delete(practiceAreas)
    .where(and(eq(practiceAreas.id, id), eq(practiceAreas.firmId, firmId)));
};

export class PracticeAreasService {
  getAllPracticeAreas = getAllPracticeAreas;
  getPracticeAreaById = getPracticeAreaById;
  createPracticeArea = createPracticeArea;
  updatePracticeArea = updatePracticeArea;
  deletePracticeArea = deletePracticeArea;
}
