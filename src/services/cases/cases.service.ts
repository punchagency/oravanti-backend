import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { staff } from "../../db/schema/staff";

// ─── Case Number Generation ──────────────────────────────────────────────────

const CASE_TYPE_CODES: Record<string, string> = {
  h1b_visa: "H1B",
  green_card: "GC",
  citizenship: "CIT",
  l1_visa: "L1",
  asylum: "ASY",
  family_petition: "FAM",
  e2_treaty_investor: "E2",
  o1_extraordinary_ability: "O1",
  eb1_priority_workers: "EB1",
  eb2_advanced_degree: "EB2",
  eb3_skilled_workers: "EB3",
  eb5_immigrant_investor: "EB5",
  work_authorization: "EAD",
  travel_document: "TRV",
  naturalization: "NAT",
  other: "OTH",
};

export const generateCaseNumber = async (
  caseType: string,
  firmId: string,
): Promise<string> => {
  const year = new Date().getFullYear();
  const typeCode = CASE_TYPE_CODES[caseType] ?? "OTH";
  const prefix = `${year}-${typeCode}-`;

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
  },
) => {
  const rows = await db
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
    .where(eq(cases.firmId, firmId))
    .orderBy(desc(cases.createdAt));

  return rows
    .filter((r) => {
      if (filters?.status && r.status !== filters.status) return false;
      if (filters?.assigneeId && r.assigneeFirstName === null) return false;
      if (filters?.clientId && r.clientId !== filters.clientId) return false;
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
      caseType: r.caseType,
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
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(and(eq(cases.id, id), eq(cases.firmId, firmId)));
  return row ?? null;
};

export const createCase = async (
  firmId: string,
  data: {
    clientId: string;
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
  const caseNumber =
    data.caseNumber || (await generateCaseNumber(data.caseType, firmId));

  const [newCase] = await db
    .insert(cases)
    .values({
      firmId,
      caseNumber,
      clientId: data.clientId,
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
