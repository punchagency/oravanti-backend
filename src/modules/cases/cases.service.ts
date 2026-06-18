import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";

// ─── Case Number Generation ──────────────────────────────────────────────────

export const generateCaseNumber = async (
  organizationId: string,
  practiceAreaId: string,
  caseType: string,
): Promise<string> => {
  const { caseType: practiceAreaCaseType } =
    await ensureCaseTypeBelongsToPracticeArea(organizationId, practiceAreaId, caseType);
  const year = new Date().getFullYear();
  const prefix = `${year}-${practiceAreaCaseType.caseNumberPrefix}-`;

  const existing = await db
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(
      and(eq(cases.organizationId, organizationId), ilike(cases.caseNumber, `${prefix}%`)),
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
  organizationId: string,
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
      caseTypeId: practiceAreaCaseTypes.id,
      caseType: cases.caseType,
      caseTypeName: practiceAreaCaseTypes.name,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      caseTypeJurisdiction: practiceAreaCaseTypes.jurisdiction,
      subcategoryId: practiceAreaSubcategories.id,
      subcategoryCode: practiceAreaSubcategories.code,
      subcategoryName: practiceAreaSubcategories.name,
      status: cases.status,
      priority: cases.priority,
      filingDate: cases.filingDate,
      caseProgress: cases.caseProgress,
      clientId: clients.id,
      clientDisplayName: clients.displayName,
      assignedStaffId: staff.id,
      assigneeFirstName: staff.firstName,
      assigneeLastName: staff.lastName,
      assigneeRole: staff.jobTitle,
    })
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(
      clientContacts,
      and(eq(clientContacts.clientId, clients.id), eq(clientContacts.isPrimary, true)),
    )
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .leftJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    )
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(eq(cases.organizationId, organizationId))
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
          r.clientDisplayName?.toLowerCase().includes(q) ||
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
        id: r.caseTypeId,
        code: r.caseType,
        name: r.caseTypeName,
        caseNumberPrefix: r.caseNumberPrefix,
        jurisdiction: r.caseTypeJurisdiction,
        subcategory: r.subcategoryId
          ? {
              id: r.subcategoryId,
              code: r.subcategoryCode,
              name: r.subcategoryName,
            }
          : null,
      },
      status: r.status,
      priority: r.priority,
      filingDate: r.filingDate,
      caseProgress: r.caseProgress,
      client: {
        id: r.clientId,
        name: r.clientDisplayName ?? '',
      },
      assignee: r.assigneeFirstName
        ? {
            name: `${r.assigneeFirstName} ${r.assigneeLastName}`,
            role: r.assigneeRole,
          }
        : null,
    }));
};

export const getCaseById = async (id: string, organizationId: string) => {
  const [row] = await db
    .select()
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .leftJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    )
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)));
  return row ?? null;
};

export const createCase = async (
  organizationId: string,
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
    leadId?: string;
  },
  creator?: { adminId?: string; staffId?: string },
) => {
  const resolvedCaseType = await ensureCaseTypeBelongsToPracticeArea(
    organizationId,
    data.practiceAreaId,
    data.caseType,
  );

  const caseNumber =
    data.caseNumber ||
    (await generateCaseNumber(organizationId, data.practiceAreaId, data.caseType));

  const [newCase] = await db
    .insert(cases)
    .values({
      organizationId,
      caseNumber,
      clientId: data.clientId,
      practiceAreaId: data.practiceAreaId,
      caseTypeId: resolvedCaseType.caseType.id,
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
      leadId: data.leadId,
      createdByAdminId: creator?.adminId,
      createdByStaffId: creator?.staffId,
    })
    .returning();

  return newCase;
};

export const updateCase = async (
  id: string,
  organizationId: string,
  data: Partial<typeof cases.$inferInsert>,
) => {
  if (data.practiceAreaId || data.caseType) {
    const [existing] = await db
      .select({
        practiceAreaId: cases.practiceAreaId,
        caseType: cases.caseType,
      })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!existing) return null;

    const resolvedCaseType = await ensureCaseTypeBelongsToPracticeArea(
      organizationId,
      data.practiceAreaId ?? existing.practiceAreaId,
      data.caseType ?? existing.caseType,
    );
    data.caseTypeId = resolvedCaseType.caseType.id;
  }

  const [updated] = await db
    .update(cases)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
    .returning();
  return updated;
};

export const deleteCase = async (id: string, organizationId: string) => {
  await db.delete(cases).where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)));
};

export class CasesService {
  generateCaseNumber = generateCaseNumber;
  getAllCases = getAllCases;
  getCaseById = getCaseById;
  createCase = createCase;
  updateCase = updateCase;
  deleteCase = deleteCase;
}
