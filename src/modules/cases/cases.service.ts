import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { team } from "../../db/schema/auth-schema";
import { tasks } from "../../db/schema/tasks";
import { cases } from "../../db/schema/cases";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";
import {
  materializeTasksForCase,
  reresolveDueDates,
} from "../workflow/task-materialization.service";
import { logCaseEvent } from "./case-events.service";
import type { UpdateCaseInput } from "./cases.validation";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("cases.service");

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
      SELECT ${tasks.title}
      FROM ${tasks}
      WHERE ${tasks.caseId} = ${cases.id}
        AND ${tasks.source} = 'workflow'
        AND ${tasks.status} NOT IN ('completed', 'skipped')
      ORDER BY ${tasks.orderIndex}
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
      SELECT ${tasks.title}
      FROM ${tasks}
      WHERE ${tasks.caseId} = ${cases.id}
        AND ${tasks.source} = 'workflow'
        AND ${tasks.status} NOT IN ('completed', 'skipped')
      ORDER BY ${tasks.orderIndex}
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
      clientEmail: clients.email,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
      caseTypeId: practiceAreaCaseTypes.id,
      caseTypeName: practiceAreaCaseTypes.name,
      assignedTeamId: team.id,
      assignedTeamName: team.name,
      currentStep: currentStepSubquery,
      parentCaseId: cases.parentCaseId,
      relationType: cases.relationType,
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

  /*
    Linked matters, both directions.

    A mandamus action is its own case that points at the AOS matter it is
    chasing, so the AOS case needs to show its children and the mandamus case
    needs to show its parent — the same relationship read from either end.
    Chains are rejected at link time (see case-link.service.ts), so one level
    each way is the whole picture, not a first page of one.
  */
  const parentAlias = alias(cases, "parent_case");

  const [parent] = row.parentCaseId
    ? await db
        .select({ id: parentAlias.id, caseNumber: parentAlias.caseNumber, status: parentAlias.status })
        .from(parentAlias)
        .where(eq(parentAlias.id, row.parentCaseId))
        .limit(1)
    : [];

  const children = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      status: cases.status,
      relationType: cases.relationType,
    })
    .from(cases)
    .where(and(eq(cases.parentCaseId, id), eq(cases.organizationId, organizationId)));

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    status: row.status,
    createdAt: row.createdAt,
    estimatedCompletionDate: row.estimatedCompletionDate,
    client: row.clientName
      ? { id: row.clientId, name: row.clientName, email: row.clientEmail }
      : null,
    practiceArea: row.practiceAreaName ? { id: row.practiceAreaId, name: row.practiceAreaName } : null,
    caseType: row.caseTypeName ? { id: row.caseTypeId, name: row.caseTypeName } : null,
    assignedTeam: row.assignedTeamName ? { id: row.assignedTeamId, name: row.assignedTeamName } : null,
    currentStep: row.currentStep ?? null,
    parentCase: parent ? { ...parent, relationType: row.relationType } : null,
    linkedCases: children,
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
      assignedTeamId: data.assignedTeamId ?? null,
      filingDate: data.filingDate ?? null,
      estimatedCompletionDate: data.estimatedCompletionDate,
      description: data.description,
      leadId: data.leadId,
      openedById: creator?.adminId ?? creator?.staffId ?? "",
    })
    .returning();

  const actorId = creator?.adminId ?? creator?.staffId;

  // Log case created event
  await logCaseEvent({
    organizationId,
    caseId: newCase.id,
    action: "case.created",
    
    summary: `Case ${newCase.caseNumber} created`,
    metadata: { caseNumber: newCase.caseNumber, description: data.description },
    actorId,
  });

  // Log team assigned event if team was provided
  if (data.assignedTeamId) {
    await logCaseEvent({
      organizationId,
      caseId: newCase.id,
      action: "case.team_assigned",
      
      summary: `Team assigned to case`,
      metadata: { teamId: data.assignedTeamId },
      actorId,
    });
  }

  log.action("case.created", { caseId: newCase.id });

  return newCase;
};

/**
 * Fields a caller may change on a case.
 *
 * This is `UpdateCaseInput` from the route schema plus the few fields the
 * application sets on the caller's behalf (`reassignmentDate`). It is
 * deliberately NOT `Partial<typeof cases.$inferInsert>`, which made every
 * column writable — including `organizationId`, so a PATCH could move a matter
 * into another firm.
 */
type UpdateCaseData = UpdateCaseInput & {
  reassignmentDate?: Date;
};

export const updateCase = async (
  id: string,
  organizationId: string,
  data: UpdateCaseData,
  actorId?: string,
) => {
  // Fetch current state for change detection
  const [currentCase] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
    .limit(1);

  if (!currentCase) return null;

  if (data.practiceAreaId || data.caseTypeId) {
    data.caseTypeId = data.caseTypeId ?? currentCase.caseTypeId;
  }

  const [updated] = await db
    .update(cases)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)))
    .returning();

  // Log specific change events
  if (data.status && data.status !== currentCase.status) {
    await logCaseEvent({
      organizationId,
      caseId: id,
      action: "case.status_changed",
      
      summary: `Status changed from ${currentCase.status} to ${data.status}`,
      metadata: { previousStatus: currentCase.status, newStatus: data.status },
      actorId,
    });
  }

  if (data.priority && data.priority !== currentCase.priority) {
    await logCaseEvent({
      organizationId,
      caseId: id,
      action: "case.priority_changed",
      
      summary: `Priority changed from ${currentCase.priority} to ${data.priority}`,
      metadata: { previousPriority: currentCase.priority, newPriority: data.priority },
      actorId,
    });
  }

  if (data.assignedTeamId !== undefined && data.assignedTeamId !== currentCase.assignedTeamId) {
    const action = currentCase.assignedTeamId
      ? ("case.team_reassigned" as const)
      : ("case.team_assigned" as const);

    const teamIds = [currentCase.assignedTeamId, data.assignedTeamId].filter(Boolean) as string[];
    const teamNames: Record<string, string> = {};
    if (teamIds.length > 0) {
      const teams = await db
        .select({ id: team.id, name: team.name })
        .from(team)
        .where(sql`${team.id} IN ${teamIds}`);
      for (const t of teams) {
        teamNames[t.id] = t.name;
      }
    }

    const previousTeam = currentCase.assignedTeamId
      ? { id: currentCase.assignedTeamId, name: teamNames[currentCase.assignedTeamId] ?? null }
      : null;
    const newTeam = data.assignedTeamId
      ? { id: data.assignedTeamId, name: teamNames[data.assignedTeamId] ?? null }
      : null;

    await logCaseEvent({
      organizationId,
      caseId: id,
      action,
      summary: `Team changed from ${previousTeam?.name ?? "none"} to ${newTeam?.name ?? "none"}`,
      metadata: { previousTeam, newTeam },
      actorId,
    });

    /*
      Generate the workflow now that there is a team to assign it from.

      `materializeTasksForCase` returns without doing anything when a case has
      no team, because every step is assigned from the team and generating
      early would produce a board of unassignable work. That is correct, but
      nothing was picking the work back up once a team arrived: a case opened
      unassigned — which is the normal way one gets opened — kept an empty
      workflow tab forever, and the tab gave no reason for it.

      Idempotent, so a reassignment costs one no-op pass rather than needing to
      be distinguished from a first assignment. Same reasoning as the
      `filingDate` hook below: this path writes a field the workflow engine
      depends on without going through `upsertImmigrationDetails`, so it has to
      run the hook itself.
    */
    if (data.assignedTeamId) {
      await materializeTasksForCase(id);
      log.action("workflow.materialized_on_team_assignment", { caseId: id });
    }
  }

  // Generic update event for any other changes
  if (data.description && data.description !== currentCase.description) {
    await logCaseEvent({
      organizationId,
      caseId: id,
      action: "case.description_updated",
      
      summary: "Case description updated",
      metadata: { changes: Object.keys(data).filter(k => k !== "updatedAt") },
      actorId,
    });
  }

  // `filingDate` is the `filed_date` due-date anchor, and it is the one anchor
  // written through this path instead of `upsertImmigrationDetails` - so it
  // misses the three write hooks that live there. Without this, a step anchored
  // on `filed_date` that was materialized before the filing date was entered
  // keeps its null due date forever.
  //
  // Only re-resolves; it cannot activate a module, because no condition
  // branches on a filing date.
  if (data.filingDate !== undefined && data.filingDate !== currentCase.filingDate) {
    const reresolved = await reresolveDueDates(id);
    log.action("workflow.due_dates_reresolved", { caseId: id, updated: reresolved });
  }

  log.action("case.updated", { caseId: id });

  return updated;
};

export const deleteCase = async (id: string, organizationId: string, actorId?: string) => {
  // Log deletion event before deleting
  await logCaseEvent({
    organizationId,
    caseId: id,
    action: "case.deleted",
    
    summary: "Case deleted",
    actorId,
  });

  await db
    .delete(cases)
    .where(and(eq(cases.id, id), eq(cases.organizationId, organizationId)));

  log.action("case.archived", { caseId: id });
};

export class CasesService {
  generateCaseNumber = generateCaseNumber;
  getAllCases = getAllCases;
  getCaseById = getCaseById;
  createCase = createCase;
  // Aliased directly — a re-declared signature here would widen the narrowed
  // input type back to "every column", which is the hole this closed.
  updateCase = updateCase;
  deleteCase = deleteCase;
}
