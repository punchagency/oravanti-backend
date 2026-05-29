import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";

// ─── Case Number Generation ──────────────────────────────────────────────────

export const generateCaseNumber = async (
  firmId: string,
  practiceAreaId: string,
  caseType: string,
): Promise<string> => {
  const { caseType: practiceAreaCaseType } =
    await ensureCaseTypeBelongsToPracticeArea(firmId, practiceAreaId, caseType);
  const year = new Date().getFullYear();
  const prefix = `${year}-${practiceAreaCaseType.caseNumberPrefix}-`;

  const existing = await db
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(
      and(eq(cases.firmId, firmId), ilike(cases.caseNumber, `${prefix}%`)),
    );

  const maxSeq = existing.reduce((max, row) => {
    const seq = parseInt(row.caseNumber.split("-").pop() ?? "0", 10);
    return seq > max ? seq : max;
  }, 0);

  const next = String(maxSeq + 1).padStart(3, "0");
  return `${prefix}${next}`;
};

// ─── Cases CRUD ──────────────────────────────────────────────────────────────

export const getAllCases = async (
  firmId: string,
  filters?: {
    search?: string;
    status?: string;
    assigneeId?: string;
    clientId?: string;
    practiceAreaId?: string;
  },
) => {
  const rows = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
      caseType: cases.caseType,
      caseTypeName: practiceAreaCaseTypes.name,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      status: cases.status,
      priority: cases.priority,
      filingDate: cases.filingDate,
      caseProgress: cases.caseProgress,
      clientId: clients.id,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      assignedStaffId: staff.id,
      assigneeFirstName: staff.firstName,
      assigneeLastName: staff.lastName,
      assigneeRole: staff.role,
    })
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      and(
        eq(practiceAreaCaseTypes.practiceAreaId, cases.practiceAreaId),
        eq(practiceAreaCaseTypes.code, cases.caseType),
      ),
    )
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(eq(cases.firmId, firmId))
    .orderBy(desc(cases.createdAt));

  return rows
    .filter((r) => {
      if (filters?.status && r.status !== filters.status) return false;
      if (filters?.assigneeId && r.assignedStaffId !== filters.assigneeId) {
        return false;
      }
      if (filters?.clientId && r.clientId !== filters.clientId) return false;
      if (
        filters?.practiceAreaId &&
        r.practiceAreaId !== filters.practiceAreaId
      ) {
        return false;
      }
      if (filters?.search) {
        const q = filters.search.toLowerCase();
        const matches =
          r.caseNumber.toLowerCase().includes(q) ||
          r.clientFirstName?.toLowerCase().includes(q) ||
          r.clientLastName?.toLowerCase().includes(q) ||
          r.caseType.toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    })
    .map((r) => ({
      id: r.id,
      caseNumber: r.caseNumber,
      practiceArea: {
        id: r.practiceAreaId,
        name: r.practiceAreaName,
      },
      caseType: {
        code: r.caseType,
        name: r.caseTypeName,
        caseNumberPrefix: r.caseNumberPrefix,
      },
      status: r.status,
      priority: r.priority,
      filingDate: r.filingDate,
      caseProgress: r.caseProgress,
      client: {
        id: r.clientId,
        name: `${r.clientFirstName} ${r.clientLastName}`,
      },
      assignee: r.assigneeFirstName
        ? {
            name: `${r.assigneeFirstName} ${r.assigneeLastName}`,
            role: r.assigneeRole,
          }
        : null,
    }));
};

export const getCaseById = async (id: string, firmId: string) => {
  const [row] = await db
    .select()
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      and(
        eq(practiceAreaCaseTypes.practiceAreaId, cases.practiceAreaId),
        eq(practiceAreaCaseTypes.code, cases.caseType),
      ),
    )
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(and(eq(cases.id, id), eq(cases.firmId, firmId)));
  return row ?? null;
};

export const createCase = async (
  firmId: string,
  data: {
    clientId: string;
    practiceAreaId: string;
    caseType: string;
    caseNumber?: string;
    priority?: string;
    assignmentType?: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    filingDate: string;
    estimatedCompletionDate?: string;
    description: string;
    notes?: string;
    currentEmployer?: string;
  },
  creator?: { adminId?: string; staffId?: string },
) => {
  await ensureCaseTypeBelongsToPracticeArea(
    firmId,
    data.practiceAreaId,
    data.caseType,
  );

  const caseNumber =
    data.caseNumber ||
    (await generateCaseNumber(firmId, data.practiceAreaId, data.caseType));

  const [newCase] = await db
    .insert(cases)
    .values({
      firmId,
      caseNumber,
      clientId: data.clientId,
      practiceAreaId: data.practiceAreaId,
      caseType: data.caseType as any,
      priority: (data.priority ?? "medium") as any,
      assignmentType: data.assignmentType ?? "internal_team",
      teamId: data.teamId,
      assignedStaffId: data.assignedStaffId,
      requiredCertifications: data.requiredCertifications ?? [],
      filingDate: data.filingDate,
      estimatedCompletionDate: data.estimatedCompletionDate,
      description: data.description,
      notes: data.notes,
      currentEmployer: data.currentEmployer,
      createdByAdminId: creator?.adminId,
      createdByStaffId: creator?.staffId,
    })
    .returning();

  return newCase;
};

export const updateCase = async (
  id: string,
  firmId: string,
  data: Partial<typeof cases.$inferInsert>,
) => {
  if (data.practiceAreaId || data.caseType) {
    const [existing] = await db
      .select({
        practiceAreaId: cases.practiceAreaId,
        caseType: cases.caseType,
      })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.firmId, firmId)))
      .limit(1);

    if (!existing) return null;

    await ensureCaseTypeBelongsToPracticeArea(
      firmId,
      data.practiceAreaId ?? existing.practiceAreaId,
      data.caseType ?? existing.caseType,
    );
  }

  const [updated] = await db
    .update(cases)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(cases.id, id), eq(cases.firmId, firmId)))
    .returning();
  return updated;
};

export const deleteCase = async (id: string, firmId: string) => {
  await db.delete(cases).where(and(eq(cases.id, id), eq(cases.firmId, firmId)));
};

export class CasesService {
  generateCaseNumber = generateCaseNumber;
  getAllCases = getAllCases;
  getCaseById = getCaseById;
  createCase = createCase;
  updateCase = updateCase;
  deleteCase = deleteCase;
}
