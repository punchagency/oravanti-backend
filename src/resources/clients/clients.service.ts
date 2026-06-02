import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { cases } from "../../db/schema/cases";
import { certifications } from "../../db/schema/certifications";
import { clients } from "../../db/schema/clients";
import { companies } from "../../db/schema/companies";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { teamMembers } from "../../db/schema/team-members";
import {
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { generateCaseNumber } from "../cases/cases.service";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";
import { db } from "./../../db/client";

// ─── Companies ───────────────────────────────────────────────────────────────

export const createCompany = async (
  organizationId: string,
  data: {
    companyName: string;
    companyType: string;
    ein?: string;
    industry?: string;
    numberOfEmployees?: number;
    address: string;
    city: string;
    state: string;
    zipCode?: string;
    country: string;
    phone?: string;
    website?: string;
    primaryContactName?: string;
    primaryContactEmail?: string;
    primaryContactPhone?: string;
  },
) => {
  const [company] = await db
    .insert(companies)
    .values({ ...data, organizationId, companyType: data.companyType as any })
    .returning();
  return company;
};

export const getAllCompanies = async (organizationId: string) => {
  const rows = await db
    .select({
      id: companies.id,
      companyName: companies.companyName,
      companyType: companies.companyType,
      industry: companies.industry,
      country: companies.country,
      status: companies.status,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .where(eq(companies.organizationId, organizationId))
    .orderBy(desc(companies.createdAt));

  return rows;
};

export const getCompanyById = async (id: string, organizationId: string) => {
  const [company] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));

  if (!company) return null;

  const companyClients = await db
    .select({
      id: clients.id,
      firstName: clients.firstName,
      middleName: clients.middleName,
      lastName: clients.lastName,
      email: clients.email,
      status: clients.status,
    })
    .from(clients)
    .where(and(eq(clients.companyId, id), eq(clients.organizationId, organizationId)));

  return { ...company, clients: companyClients };
};

export const updateCompany = async (
  id: string,
  organizationId: string,
  data: Partial<typeof companies.$inferInsert>,
) => {
  const [updated] = await db
    .update(companies)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)))
    .returning();
  return updated;
};

export const deleteCompany = async (
  id: string,
  organizationId: string,
): Promise<void> => {
  await db
    .delete(companies)
    .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
};

export class ClientsService {
  createCompany = createCompany;
  getAllCompanies = getAllCompanies;
  getCompanyById = getCompanyById;
  updateCompany = updateCompany;
  deleteCompany = deleteCompany;
  createCompanyWithClients = createCompanyWithClients;
  addClientToCompany = addClientToCompany;
  getCertifications = getCertifications;
  getAllClients = getAllClients;
  getClientById = getClientById;
  createClient = createClient;
  updateClient = updateClient;
  deleteClient = deleteClient;
  getClientCases = getClientCases;
  addCase = addCase;
  updateCaseStatus = updateCaseStatus;
  getTeamStaff = getTeamStaff;
}

// ─── Company client batch creation ───────────────────────────────────────────

export const createCompanyWithClients = async (
  organizationId: string,
  companyData: Parameters<typeof createCompany>[1],
  individuals: Array<{
    clientData: {
      firstName: string;
      middleName?: string;
      lastName: string;
      secondLastName?: string;
      thirdLastName?: string;
      fourthLastName?: string;
      email: string;
      phone: string;
      dateOfBirth: string;
      nationality: string;
      countryOfOrigin: string;
      passportNumber?: string;
      currentAddress: string;
    };
    caseData: {
      practiceAreaId: string;
      caseType: string;
      description: string;
      filingDate: string;
      teamId?: string;
      assignedStaffId?: string;
      requiredCertifications?: string[];
      currentEmployer?: string;
      notes?: string;
    };
  }>,
  creator?: { adminId?: string; staffId?: string },
  options?: { acknowledgeConflict?: boolean },
) => {
  for (const { clientData } of individuals) {
    await checkForDuplicate(organizationId, clientData);
  }

  if (!options?.acknowledgeConflict) {
    const allConflicts: Array<{
      individual: number;
      conflicts: ConflictResult[];
    }> = [];
    for (let i = 0; i < individuals.length; i++) {
      const conflicts = await checkForConflicts(
        organizationId,
        individuals[i].clientData,
      );
      if (conflicts.length) allConflicts.push({ individual: i, conflicts });
    }
    if (allConflicts.length)
      return { type: "conflict_warning" as const, conflicts: allConflicts };
  }

  for (const { caseData } of individuals) {
    await ensureCaseTypeBelongsToPracticeArea(
      organizationId,
      caseData.practiceAreaId,
      caseData.caseType,
    );
  }

  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        ...companyData,
        organizationId,
        companyType: companyData.companyType as any,
      })
      .returning();

    const results = [];

    for (const { clientData, caseData } of individuals) {
      const caseNumber = await generateCaseNumber(
        organizationId,
        caseData.practiceAreaId,
        caseData.caseType,
      );

      const [newClient] = await tx
        .insert(clients)
        .values({
          ...clientData,
          organizationId,
          status: "active",
          clientType: "company_representative",
          companyId: company.id,
        })
        .returning();

      const [newCase] = await tx
        .insert(cases)
        .values({
          organizationId,
          caseNumber,
          clientId: newClient.id,
          practiceAreaId: caseData.practiceAreaId,
          caseType: caseData.caseType as any,
          description: caseData.description,
          filingDate: caseData.filingDate,
          teamId: caseData.teamId,
          assignedStaffId: caseData.assignedStaffId,
          requiredCertifications: caseData.requiredCertifications ?? [],
          currentEmployer: company.companyName,
          notes: caseData.notes,
          createdByAdminId: creator?.adminId,
          createdByStaffId: creator?.staffId,
        })
        .returning();

      results.push({ client: newClient, case: newCase });
    }

    return { company, individuals: results };
  });
};

// ─── Add individual to existing company ──────────────────────────────────────

export const addClientToCompany = async (
  companyId: string,
  organizationId: string,
  clientData: {
    firstName: string;
    middleName?: string;
    lastName: string;
    secondLastName?: string;
    thirdLastName?: string;
    fourthLastName?: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    nationality: string;
    countryOfOrigin: string;
    passportNumber?: string;
    currentAddress: string;
  },
  caseData: {
    practiceAreaId: string;
    caseType: string;
    description: string;
    filingDate: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    notes?: string;
  },
  creator?: { adminId?: string; staffId?: string },
) => {
  const [company] = await db
    .select({ id: companies.id, companyName: companies.companyName })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)));

  if (!company) throw new NotFoundError("Company not found");

  await ensureCaseTypeBelongsToPracticeArea(
    organizationId,
    caseData.practiceAreaId,
    caseData.caseType,
  );
  await checkForDuplicate(organizationId, clientData);

  return db.transaction(async (tx) => {
    const caseNumber = await generateCaseNumber(
      organizationId,
      caseData.practiceAreaId,
      caseData.caseType,
    );

    const [newClient] = await tx
      .insert(clients)
      .values({
        ...clientData,
        organizationId,
        status: "active",
        clientType: "company_representative",
        companyId,
      })
      .returning();

    const [newCase] = await tx
      .insert(cases)
      .values({
        organizationId,
        caseNumber,
        clientId: newClient.id,
        practiceAreaId: caseData.practiceAreaId,
        caseType: caseData.caseType as any,
        description: caseData.description,
        filingDate: caseData.filingDate,
        teamId: caseData.teamId,
        assignedStaffId: caseData.assignedStaffId,
        requiredCertifications: caseData.requiredCertifications ?? [],
        currentEmployer: company.companyName,
        notes: caseData.notes,
        createdByAdminId: creator?.adminId,
        createdByStaffId: creator?.staffId,
      })
      .returning();

    return { client: newClient, case: newCase };
  });
};

// ─── Conflict of Interest Detection ──────────────────────────────────────────

export type ConflictResult = {
  existingClientId: string;
  existingClientName: string;
  reason: "same_surname_and_address" | "same_surname" | "same_address";
  message: string;
};

export const checkForConflicts = async (
  organizationId: string,
  data: { lastName: string; currentAddress: string },
  excludeId?: string,
): Promise<ConflictResult[]> => {
  const existing = await db
    .select({
      id: clients.id,
      firstName: clients.firstName,
      lastName: clients.lastName,
      currentAddress: clients.currentAddress,
    })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const conflicts: ConflictResult[] = [];

  for (const client of existing) {
    if (excludeId && client.id === excludeId) continue;

    const sameSurname = normName(client.lastName) === normName(data.lastName);
    const sameAddress =
      normName(client.currentAddress) === normName(data.currentAddress);
    const name = `${client.firstName} ${client.lastName}`;

    if (sameSurname && sameAddress) {
      conflicts.push({
        existingClientId: client.id,
        existingClientName: name,
        reason: "same_surname_and_address",
        message: `We are representing someone with the same surname living at the same address (${name})`,
      });
    } else if (sameSurname) {
      conflicts.push({
        existingClientId: client.id,
        existingClientName: name,
        reason: "same_surname",
        message: `We are representing someone with the same surname (${name})`,
      });
    } else if (sameAddress) {
      conflicts.push({
        existingClientId: client.id,
        existingClientName: name,
        reason: "same_address",
        message: `We are representing someone at the same address (${name})`,
      });
    }
  }

  return conflicts;
};

// ─── Duplicate Detection ──────────────────────────────────────────────────────

const normName = (s?: string | null) => (s ?? "").trim().toLowerCase();

const checkForDuplicate = async (
  organizationId: string,
  data: {
    email: string;
    passportNumber?: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    secondLastName?: string;
    thirdLastName?: string;
    fourthLastName?: string;
    dateOfBirth: string;
  },
  excludeId?: string,
) => {
  const existing = await db
    .select({
      id: clients.id,
      email: clients.email,
      passportNumber: clients.passportNumber,
      firstName: clients.firstName,
      middleName: clients.middleName,
      lastName: clients.lastName,
      secondLastName: clients.secondLastName,
      thirdLastName: clients.thirdLastName,
      fourthLastName: clients.fourthLastName,
      dateOfBirth: clients.dateOfBirth,
    })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  for (const client of existing) {
    if (excludeId && client.id === excludeId) continue;

    if (client.email.toLowerCase() === data.email.toLowerCase()) {
      throw new ConflictError(
        "A client with this email address already exists at this firm",
      );
    }

    if (
      data.passportNumber &&
      client.passportNumber &&
      client.passportNumber === data.passportNumber
    ) {
      throw new ConflictError(
        "A client with this passport number already exists at this firm",
      );
    }

    const sameFullName =
      normName(client.firstName) === normName(data.firstName) &&
      normName(client.middleName) === normName(data.middleName) &&
      normName(client.lastName) === normName(data.lastName) &&
      normName(client.secondLastName) === normName(data.secondLastName) &&
      normName(client.thirdLastName) === normName(data.thirdLastName) &&
      normName(client.fourthLastName) === normName(data.fourthLastName) &&
      client.dateOfBirth === data.dateOfBirth;

    if (sameFullName) {
      const fullName = [
        data.firstName,
        data.middleName,
        data.lastName,
        data.secondLastName,
        data.thirdLastName,
        data.fourthLastName,
      ]
        .filter(Boolean)
        .join(" ");
      throw new ConflictError(
        `A client named "${fullName}" with this date of birth already exists at this firm`,
      );
    }
  }
};

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

type ClientListOptions = Partial<PaginationParams> & {
  search?: string;
  all?: boolean;
};

type ClientListRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryOfOrigin: string;
  status: string;
};

const mapClientListRows = async (
  organizationId: string,
  clientRows: ClientListRow[],
) => {
  const clientIds = clientRows.map((client) => client.id);
  if (!clientIds.length) return [];

  const caseRows = await db
    .select({
      caseId: cases.id,
      clientId: cases.clientId,
      caseType: cases.caseType,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
      caseStatus: cases.status,
      caseProgress: cases.caseProgress,
      nextAppointment: cases.nextAppointment,
      assignedStaffFirstName: staff.firstName,
      assignedStaffLastName: staff.lastName,
    })
    .from(cases)
    .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
    .leftJoin(staff, eq(staff.id, cases.assignedStaffId))
    .where(
      and(
        eq(cases.organizationId, organizationId),
        inArray(cases.clientId, clientIds),
      ),
    )
    .orderBy(desc(cases.createdAt));

  const activeCaseByClientId = new Map<string, (typeof caseRows)[number]>();
  for (const caseRow of caseRows) {
    if (!activeCaseByClientId.has(caseRow.clientId)) {
      activeCaseByClientId.set(caseRow.clientId, caseRow);
    }
  }

  return clientRows.map((client) => {
    const activeCase = activeCaseByClientId.get(client.id);

    return {
      id: client.id,
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email,
      phone: client.phone,
      countryOfOrigin: client.countryOfOrigin,
      status: client.status,
      activeCase: activeCase
        ? {
            id: activeCase.caseId,
            caseType: activeCase.caseType,
            practiceArea: {
              id: activeCase.practiceAreaId,
              name: activeCase.practiceAreaName,
            },
            status: activeCase.caseStatus,
            caseProgress: activeCase.caseProgress,
            nextAppointment: activeCase.nextAppointment,
            assignedTo: activeCase.assignedStaffFirstName
              ? `${activeCase.assignedStaffFirstName} ${activeCase.assignedStaffLastName}`
              : null,
          }
        : null,
    };
  });
};

export const getAllClients = async (
  organizationId: string,
  options: ClientListOptions = {},
) => {
  const search = options.search?.trim();
  const where = search
    ? and(
        eq(clients.organizationId, organizationId),
        or(
          ilike(clients.firstName, `%${search}%`),
          ilike(clients.lastName, `%${search}%`),
          ilike(clients.email, `%${search}%`),
          ilike(cases.caseType, `%${search}%`),
        ),
      )
    : eq(clients.organizationId, organizationId);

  const selectMatchingClients = () =>
    db
      .selectDistinct({
        id: clients.id,
        firstName: clients.firstName,
        lastName: clients.lastName,
        email: clients.email,
        phone: clients.phone,
        countryOfOrigin: clients.countryOfOrigin,
        status: clients.status,
        createdAt: clients.createdAt,
      })
      .from(clients)
      .leftJoin(cases, eq(cases.clientId, clients.id))
      .where(where)
      .orderBy(desc(clients.createdAt));

  if (options.all) {
    const rows = await selectMatchingClients();
    return mapClientListRows(organizationId, rows);
  }

  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [{ total }] = await db
    .select({ total: countDistinct(clients.id) })
    .from(clients)
    .leftJoin(cases, eq(cases.clientId, clients.id))
    .where(where);

  const rows = await selectMatchingClients().limit(limit).offset(offset);
  const data = await mapClientListRows(organizationId, rows);

  return buildPaginatedResponse(data, {
    page,
    limit,
    total: Number(total),
  });
};

export const getClientById = async (id: string, organizationId: string) => {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)));
  if (!client) return null;

  const clientCases = await db
    .select()
    .from(cases)
    .where(and(eq(cases.clientId, id), eq(cases.organizationId, organizationId)));
  return { ...client, cases: clientCases };
};

export const createClient = async (
  organizationId: string,
  clientData: {
    firstName: string;
    middleName?: string;
    lastName: string;
    secondLastName?: string;
    thirdLastName?: string;
    fourthLastName?: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    nationality: string;
    countryOfOrigin: string;
    passportNumber?: string;
    currentAddress: string;
  },
  caseData: {
    practiceAreaId: string;
    caseType: string;
    description: string;
    filingDate: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    currentEmployer?: string;
    notes?: string;
  },
  options?: { acknowledgeConflict?: boolean },
) => {
  await ensureCaseTypeBelongsToPracticeArea(
    organizationId,
    caseData.practiceAreaId,
    caseData.caseType,
  );

  await checkForDuplicate(organizationId, clientData);

  if (!options?.acknowledgeConflict) {
    const conflicts = await checkForConflicts(organizationId, clientData);
    if (conflicts.length)
      return { type: "conflict_warning" as const, conflicts };
  }

  const caseNumber = await generateCaseNumber(
    organizationId,
    caseData.practiceAreaId,
    caseData.caseType,
  );

  return db.transaction(async (tx) => {
    const [newClient] = await tx
      .insert(clients)
      .values({ ...clientData, organizationId, status: "active" })
      .returning();

    const [newCase] = await tx
      .insert(cases)
      .values({
        organizationId,
        caseNumber,
        clientId: newClient.id,
        practiceAreaId: caseData.practiceAreaId,
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
  organizationId: string,
  data: Partial<typeof clients.$inferInsert>,
) => {
  if (
    data.email ||
    data.passportNumber ||
    data.firstName ||
    data.middleName ||
    data.lastName ||
    data.secondLastName ||
    data.thirdLastName ||
    data.fourthLastName ||
    data.dateOfBirth
  ) {
    const current = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)))
      .limit(1);
    if (!current.length) return null;

    await checkForDuplicate(
      organizationId,
      {
        email: data.email ?? current[0].email,
        passportNumber:
          data.passportNumber ?? current[0].passportNumber ?? undefined,
        firstName: data.firstName ?? current[0].firstName,
        middleName: data.middleName ?? current[0].middleName ?? undefined,
        lastName: data.lastName ?? current[0].lastName,
        secondLastName:
          data.secondLastName ?? current[0].secondLastName ?? undefined,
        thirdLastName:
          data.thirdLastName ?? current[0].thirdLastName ?? undefined,
        fourthLastName:
          data.fourthLastName ?? current[0].fourthLastName ?? undefined,
        dateOfBirth: data.dateOfBirth ?? current[0].dateOfBirth,
      },
      id,
    );
  }

  const [updated] = await db
    .update(clients)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)))
    .returning();
  return updated;
};

export const deleteClient = async (id: string, organizationId: string) => {
  await db
    .delete(clients)
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)));
};

// ─── Cases ────────────────────────────────────────────────────────────────────

export const getClientCases = async (
  clientId: string,
  organizationId: string,
  options: (Partial<PaginationParams> & { all?: boolean }) = {},
) => {
  const where = and(eq(cases.clientId, clientId), eq(cases.organizationId, organizationId));

  const selectClientCases = () =>
    db
      .select()
      .from(cases)
      .where(where)
      .orderBy(desc(cases.createdAt));

  if (options.all) {
    return selectClientCases();
  }

  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [{ total }] = await db
    .select({ total: count() })
    .from(cases)
    .where(where);

  const rows = await selectClientCases().limit(limit).offset(offset);

  return buildPaginatedResponse(rows, {
    page,
    limit,
    total: Number(total),
  });
};

export const addCase = async (
  clientId: string,
  organizationId: string,
  caseData: {
    practiceAreaId: string;
    caseType: string;
    description: string;
    filingDate: string;
    teamId?: string;
    assignedStaffId?: string;
    requiredCertifications?: string[];
    currentEmployer?: string;
    notes?: string;
  },
  options?: { acknowledgeExistingCase?: boolean },
) => {
  await ensureCaseTypeBelongsToPracticeArea(
    organizationId,
    caseData.practiceAreaId,
    caseData.caseType,
  );

  if (!options?.acknowledgeExistingCase) {
    const existing = await db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        caseType: cases.caseType,
        status: cases.status,
      })
      .from(cases)
      .where(
        and(
          eq(cases.clientId, clientId),
          eq(cases.organizationId, organizationId),
          eq(cases.caseType, caseData.caseType as any),
        ),
      );

    if (existing.length) {
      const match = existing[0];
      return {
        type: "case_exists_warning" as const,
        message: `This client already has a ${match.caseType.replace(/_/g, " ")} case that is ${match.status.replace(/_/g, " ")} (${match.caseNumber})`,
        existingCases: existing.map((c) => ({
          id: c.id,
          caseNumber: c.caseNumber,
          caseType: c.caseType,
          status: c.status,
        })),
      };
    }
  }

  const caseNumber = await generateCaseNumber(
    organizationId,
    caseData.practiceAreaId,
    caseData.caseType,
  );

  const [newCase] = await db
    .insert(cases)
    .values({
      organizationId,
      caseNumber,
      clientId,
      practiceAreaId: caseData.practiceAreaId,
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
  organizationId: string,
  status: string,
) => {
  const [updated] = await db
    .update(cases)
    .set({ status: status as any, updatedAt: new Date() })
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .returning();
  return updated;
};

// ─── Team staff for case assignment ──────────────────────────────────────────

export const getTeamStaff = async (teamId: string, organizationId: string) => {
  return db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      role: staff.role,
    })
    .from(staff)
    .innerJoin(teamMembers, eq(teamMembers.staffId, staff.id))
    .where(and(eq(teamMembers.teamId, teamId), eq(staff.organizationId, organizationId)));
};
