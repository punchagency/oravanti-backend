import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { team } from "../../db/schema/auth-schema";
import { caseWorkflowSteps } from "../../db/schema/workflow";
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
          eq(clientContacts.type, "primary_client"),
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
      .leftJoin(team, eq(team.id, cases.assignedTeamId));

  const conditions: ReturnType<typeof sql>[] = [
    eq(cases.organizationId, organizationId),
  ];

  if (filters?.status) {
    conditions.push(eq(cases.status, filters.status as any));
  }

  if (filters?.assigneeId) {
    conditions.push(eq(cases.assignedTeamId, filters.assigneeId));
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
    .leftJoin(team, eq(team.id, cases.assignedTeamId))
    .where(and(...conditions));

  const total = Number(count);

  const currentStepSubquery = sql<string>`
    (
      SELECT ${caseWorkflowSteps.title}
      FROM ${caseWorkflowSteps}
      WHERE ${caseWorkflowSteps.caseId} = ${cases.id}
        AND ${caseWorkflowSteps.status} NOT IN ('completed', 'skipped')
      ORDER BY ${caseWorkflowSteps.orderIndex}
      LIMIT 1
    )
  `;

  const columnSelection = {
    id: cases.id,
    caseNumber: cases.caseNumber,
    practiceAreaId: practiceAreas.id,
    practiceAreaName: practiceAreas.name,
    caseTypeId: practiceAreaCaseTypes.id,
    caseTypeCode: practiceAreaCaseTypes.code,
    caseTypeName: practiceAreaCaseTypes.name,
    caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
    caseTypeJurisdiction: practiceAreaCaseTypes.jurisdiction,
    subcategoryId: practiceAreaSubcategories.id,
    subcategoryCode: practiceAreaSubcategories.code,
    subcategoryName: practiceAreaSubcategories.name,
    status: cases.status,
    priority: cases.priority,
    filingDate: cases.filingDate,
    createdAt: cases.createdAt,
    estimatedCompletionDate: cases.estimatedCompletionDate,
    caseProgress: cases.caseProgress,
    clientId: clients.id,
    clientDisplayName: clients.displayName,
    assignedTeamId: team.id,
    assigneeName: team.name,
    currentStep: currentStepSubquery,
  } as const;

  const rows = await db
    .select(columnSelection)
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.type, "primary_client"),
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
    .leftJoin(team, eq(team.id, cases.assignedTeamId))
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
      code: r.caseTypeCode,
      name: r.caseTypeName,
    },
    status: r.status,
    createdAt: r.createdAt,
    estimatedCompletionDate: r.estimatedCompletionDate,
    client: {
      id: r.clientId,
      name: r.clientDisplayName ?? "",
    },
    assignedTeam: r.assigneeName
      ? {
          id: r.assignedTeamId,
          name: r.assigneeName,
        }
      : null,
    currentStep: r.currentStep ?? null,
  }));

  return { data, pagination: { total, limit, offset } };
};

export const getCaseById = async (id: string, organizationId: string) => {
  const currentStepSubquery = sql<string>`
    (
      SELECT ${caseWorkflowSteps.title}
      FROM ${caseWorkflowSteps}
      WHERE ${caseWorkflowSteps.caseId} = ${cases.id}
        AND ${caseWorkflowSteps.status} NOT IN ('completed', 'skipped')
      ORDER BY ${caseWorkflowSteps.orderIndex}
      LIMIT 1
    )
  `;

  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      status: cases.status,
      createdAt: cases.createdAt,
      estimatedCompletionDate: cases.estimatedCompletionDate,
      clientId: clients.id,
      clientName: clients.displayName,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
      caseTypeId: practiceAreaCaseTypes.id,
      caseTypeName: practiceAreaCaseTypes.name,
      assignedTeamId: team.id,
      assignedTeamName: team.name,
      currentStep: currentStepSubquery,
    })
    .from(cases)
    .leftJoin(clients, eq(clients.id, cases.clientId))
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, cases.caseTypeId),
    )
    .leftJoin(team, eq(team.id, cases.assignedTeamId))
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    status: row.status,
    createdAt: row.createdAt,
    estimatedCompletionDate: row.estimatedCompletionDate,
    client: row.clientName ? { id: row.clientId, name: row.clientName } : null,
    practiceArea: row.practiceAreaName ? { id: row.practiceAreaId, name: row.practiceAreaName } : null,
    caseType: row.caseTypeName ? { id: row.caseTypeId, name: row.caseTypeName } : null,
    assignedTeam: row.assignedTeamName ? { id: row.assignedTeamId, name: row.assignedTeamName } : null,
    currentStep: row.currentStep ?? null,
  };
};

export const createCase = async (
  organizationId: string,
  data: {
    clientId: string;
    practiceAreaId: string;
    caseType: string;
    caseNumber?: string;
    priority?: string;
    assignedTeamId?: string;
    filingDate: string;
    estimatedCompletionDate?: string;
    description: string;
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
      priority: (data.priority ?? "medium") as any,
      assignedTeamId: data.assignedTeamId ?? "",
      filingDate: data.filingDate ?? null,
      estimatedCompletionDate: data.estimatedCompletionDate,
      description: data.description,
      leadId: data.leadId,
      openedById: creator?.adminId ?? creator?.staffId ?? "",
    })
    .returning();

  return newCase;
};

export const updateCase = async (
  id: string,
  organizationId: string,
  data: Partial<typeof cases.$inferInsert>,
) => {
  if (data.practiceAreaId || data.caseTypeId) {
    const [existing] = await db
      .select({
        practiceAreaId: cases.practiceAreaId,
        caseTypeId: cases.caseTypeId,
      })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!existing) return null;

    data.caseTypeId = data.caseTypeId ?? existing.caseTypeId;
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
