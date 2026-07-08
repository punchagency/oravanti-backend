import { and, desc, eq, ilike, sql } from "drizzle-orm";
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
    await ensureCaseTypeBelongsToPracticeArea(
      organizationId,
      practiceAreaId,
      caseType,
    );
  const year = new Date().getFullYear();
  const prefix = `${year}-${practiceAreaCaseType.caseNumberPrefix}-`;

  const existing = await db
    .select({ caseNumber: cases.caseNumber })
    .from(cases)
    .where(
      and(
        eq(cases.organizationId, organizationId),
        ilike(cases.caseNumber, `${prefix}%`),
      ),
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
    status?:
      "active" | "pending_review" | "on_hold" | "completed" | "cancelled";
    assigneeId?: string;
    clientId?: string;
    practiceAreaId?: string;
    practiceAreaName?: string;
    caseTypeName?: string;
    subcategoryName?: string;
    assigneeName?: string;
    page?: number;
    limit?: number;
  },
) => {
  const page = filters?.page ?? 1;
  const limit = filters?.limit ?? 20;
  const offset = (page - 1) * limit;

  const baseJoin = (qb: any) =>
    qb
      .from(cases)
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .leftJoin(
        clientContacts,
        and(
          eq(clientContacts.clientId, clients.id),
          eq(clientContacts.isPrimary, true),
        ),
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
      .leftJoin(staff, eq(staff.id, cases.assignedStaffId));

  const conditions: ReturnType<typeof sql>[] = [
    eq(cases.organizationId, organizationId),
  ];

  if (filters?.status) {
    conditions.push(eq(cases.status, filters.status as any));
  }

  if (filters?.assigneeId) {
    conditions.push(eq(cases.assignedStaffId, filters.assigneeId));
  }

  if (filters?.clientId) {
    conditions.push(eq(cases.clientId, filters.clientId));
  }

  if (filters?.practiceAreaId) {
    conditions.push(eq(cases.practiceAreaId, filters.practiceAreaId));
  }

  if (filters?.search) {
    const q = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(
        LOWER(${cases.caseNumber}) LIKE ${q}
        OR LOWER(${clients.displayName}) LIKE ${q}
        OR LOWER(${practiceAreaCaseTypes.name}) LIKE ${q}
      )`,
    );
  }

  if (filters?.practiceAreaName) {
    conditions.push(
      sql`LOWER(${practiceAreas.name}) LIKE ${`%${filters.practiceAreaName.toLowerCase()}%`}`,
    );
  }

  if (filters?.caseTypeName) {
    conditions.push(
      sql`LOWER(${practiceAreaCaseTypes.name}) LIKE ${`%${filters.caseTypeName.toLowerCase()}%`}`,
    );
  }

  if (filters?.subcategoryName) {
    conditions.push(
      sql`LOWER(${practiceAreaSubcategories.name}) LIKE ${`%${filters.subcategoryName.toLowerCase()}%`}`,
    );
  }

  if (filters?.assigneeName) {
    const q = `%${filters.assigneeName.toLowerCase()}%`;
    conditions.push(
      sql`(${staff.id} IS NOT NULL AND LOWER(CONCAT(${staff.firstName}, ' ', ${staff.lastName})) LIKE ${q})`,
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`COUNT(*)` })
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
    .where(and(...conditions));

  const total = Number(count);

  const columnSelection = {
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
  } as const;

  const rows = await db
    .select(columnSelection)
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.isPrimary, true),
      ),
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
    .where(and(...conditions))
    .orderBy(desc(cases.createdAt))
    .limit(limit)
    .offset(offset);

  const data = rows.map((r) => ({
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
      name: r.clientDisplayName ?? "",
    },
    assignee: r.assigneeFirstName
      ? {
          name: `${r.assigneeFirstName} ${r.assigneeLastName}`,
          role: r.assigneeRole,
        }
      : null,
  }));

  return { data, pagination: { total, limit, offset } };
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
    (await generateCaseNumber(
      organizationId,
      data.practiceAreaId,
      data.caseType,
    ));

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
  await db
    .delete(cases)
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)));
};

export class CasesService {
  generateCaseNumber = generateCaseNumber;
  getAllCases = getAllCases;
  getCaseById = getCaseById;
  createCase = createCase;
  updateCase = updateCase;
  deleteCase = deleteCase;
}
