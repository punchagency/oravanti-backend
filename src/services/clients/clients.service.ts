import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { certifications } from "../../db/schema/certifications";
import { clients } from "../../db/schema/clients";
import { staff } from "../../db/schema/staff";
import { generateCaseNumber } from "../cases/cases.service";

// ─── Certifications ───────────────────────────────────────────────────────────

export const getCertifications = async () => {
  const rows = await db.select().from(certifications);
  return rows.reduce(
    (acc, row) => {
      if (!acc[row.level]) acc[row.level] = [];
      acc[row.level].push({ code: row.code, name: row.name });
      return acc;
    },
    {} as Record<string, { code: string; name: string }[]>,
  );
};

// ─── Clients ──────────────────────────────────────────────────────────────────

export const getAllClients = async (firmId: string, search?: string) => {
  const rows = await db
    .select({
      id: clients.id,
      firstName: clients.firstName,
      lastName: clients.lastName,
      email: clients.email,
      phone: clients.phone,
      countryOfOrigin: clients.countryOfOrigin,
      status: clients.status,
      caseId: cases.id,
      caseType: cases.caseType,
      caseStatus: cases.status,
      caseProgress: cases.caseProgress,
      nextAppointment: cases.nextAppointment,
      assignedStaffFirstName: staff.firstName,
      assignedStaffLastName: staff.lastName,
    })
    .from(clients)
    .leftJoin(cases, eq(cases.clientId, clients.id))
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(
      search
        ? and(
            eq(clients.firmId, firmId),
            or(
              ilike(clients.firstName, `%${search}%`),
              ilike(clients.lastName, `%${search}%`),
              ilike(clients.email, `%${search}%`),
              ilike(cases.caseType, `%${search}%`),
            ),
          )
        : eq(clients.firmId, firmId),
    )
    .orderBy(desc(clients.createdAt));

  return rows.map((r) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    countryOfOrigin: r.countryOfOrigin,
    status: r.status,
    activeCase: r.caseId
      ? {
          id: r.caseId,
          caseType: r.caseType,
          status: r.caseStatus,
          caseProgress: r.caseProgress,
          nextAppointment: r.nextAppointment,
          assignedTo: r.assignedStaffFirstName
            ? `${r.assignedStaffFirstName} ${r.assignedStaffLastName}`
            : null,
        }
      : null,
  }));
};

export const getClientById = async (id: string, firmId: string) => {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.firmId, firmId)));
  if (!client) return null;

  const clientCases = await db
    .select()
    .from(cases)
    .where(and(eq(cases.clientId, id), eq(cases.firmId, firmId)));
  return { ...client, cases: clientCases };
};

export const createClient = async (
  firmId: string,
  clientData: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    nationality: string;
    countryOfOrigin: string;
    passportNumber?: string;
    currentAddress: string;
  },
  caseData: {
    caseType: string;
    description: string;
    filingDate: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    currentEmployer?: string;
    notes?: string;
  },
) => {
  const caseNumber = await generateCaseNumber(caseData.caseType, firmId);

  return db.transaction(async (tx) => {
    const [newClient] = await tx
      .insert(clients)
      .values({ ...clientData, firmId, status: "active" })
      .returning();

    const [newCase] = await tx
      .insert(cases)
      .values({
        firmId,
        caseNumber,
        clientId: newClient.id,
        caseType: caseData.caseType as any,
        description: caseData.description,
        filingDate: caseData.filingDate,
        teamId: caseData.teamId,
        assignedStaffId: caseData.assignedStaffId,
        requiredCertifications: caseData.requiredCertifications ?? [],
        currentEmployer: caseData.currentEmployer,
        notes: caseData.notes,
      })
      .returning();

    return { client: newClient, case: newCase };
  });
};

export const updateClient = async (
  id: string,
  firmId: string,
  data: Partial<typeof clients.$inferInsert>,
) => {
  const [updated] = await db
    .update(clients)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(clients.id, id), eq(clients.firmId, firmId)))
    .returning();
  return updated;
};

export const deleteClient = async (id: string, firmId: string) => {
  await db
    .delete(clients)
    .where(and(eq(clients.id, id), eq(clients.firmId, firmId)));
};

// ─── Cases ────────────────────────────────────────────────────────────────────

export const getClientCases = async (clientId: string, firmId: string) => {
  return db
    .select()
    .from(cases)
    .where(and(eq(cases.clientId, clientId), eq(cases.firmId, firmId)));
};

export const addCase = async (
  clientId: string,
  firmId: string,
  caseData: {
    caseType: string;
    description: string;
    filingDate: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    currentEmployer?: string;
    notes?: string;
  },
) => {
  const caseNumber = await generateCaseNumber(caseData.caseType, firmId);

  const [newCase] = await db
    .insert(cases)
    .values({
      firmId,
      caseNumber,
      clientId,
      caseType: caseData.caseType as any,
      description: caseData.description,
      filingDate: caseData.filingDate,
      teamId: caseData.teamId,
      assignedStaffId: caseData.assignedStaffId,
      requiredCertifications: caseData.requiredCertifications ?? [],
      currentEmployer: caseData.currentEmployer,
      notes: caseData.notes,
    })
    .returning();
  return newCase;
};

export const updateCaseStatus = async (
  caseId: string,
  firmId: string,
  status: string,
) => {
  const [updated] = await db
    .update(cases)
    .set({ status: status as any, updatedAt: new Date() })
    .where(and(eq(cases.id, caseId), eq(cases.firmId, firmId)))
    .returning();
  return updated;
};

// ─── Team staff for case assignment ──────────────────────────────────────────

export const getTeamStaff = async (teamId: string, firmId: string) => {
  return db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      role: staff.role,
    })
    .from(staff)
    .where(and(eq(staff.teamId, teamId), eq(staff.firmId, firmId)));
};
