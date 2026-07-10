import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  or,
} from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { certifications } from "../../db/schema/cases";
import { clientCompanies } from "../../db/schema/client-companies";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { practiceAreas } from "../../db/schema/practice-areas";
import { staff } from "../../db/schema/staff";
import { teamMembers } from "../../db/schema/team-members";
import { ConflictError, NotFoundError } from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { db as _db } from "../../db/client";
import { generateCaseNumber } from "../cases/cases.service";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";

// ─── Clients (Legal Entities) ─────────────────────────────────────────────────

type ClientListOptions = Partial<PaginationParams> & { search?: string; all?: boolean };

export const getAllClients = async (
  organizationId: string,
  options: ClientListOptions = {},
) => {
  const search = options.search?.trim();

  const baseQuery = db
    .selectDistinct({
      id: clients.id,
      entityType: clients.entityType,
      displayName: clients.displayName,
      status: clients.status,
      createdAt: clients.createdAt,
      // Primary contact fields for display
      contactEmail: clientContacts.email,
      contactPhone: clientContacts.phone,
    })
    .from(clients)
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.clientId, clients.id),
        eq(clientContacts.type, 'primary_client'),
      ),
    )
    .where(
      search
        ? and(
            eq(clients.organizationId, organizationId),
            or(
              ilike(clients.displayName, `%${search}%`),
              ilike(clientContacts.email, `%${search}%`),
            ),
          )
        : eq(clients.organizationId, organizationId),
    )
    .orderBy(desc(clients.createdAt));

  if (options.all) return baseQuery;

  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [{ total }] = await db
    .select({ total: count() })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const rows = await baseQuery.limit(limit).offset(offset);
  return buildPaginatedResponse(rows, { page, limit, total: Number(total) });
};

export const getClientById = async (id: string, organizationId: string) => {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)));

  if (!client) return null;

  const contacts = await db
    .select()
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.clientId, id),
        eq(clientContacts.organizationId, organizationId),
      ),
    )
    .orderBy(asc(clientContacts.type));

  const [company] = await db
    .select()
    .from(clientCompanies)
    .where(and(eq(clientCompanies.clientId, id), eq(clientCompanies.organizationId, organizationId)));

  const clientCases = await db
    .select()
    .from(cases)
    .where(and(eq(cases.clientId, id), eq(cases.organizationId, organizationId)));

  return { ...client, contacts, company: company ?? null, cases: clientCases };
};

export const updateClient = async (
  id: string,
  organizationId: string,
  data: { displayName?: string; status?: string; entityType?: string },
) => {
  const [updated] = await db
    .update(clients)
    .set({ ...data as any, updatedAt: new Date() })
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)))
    .returning();
  return updated ?? null;
};

export const deleteClient = async (id: string, organizationId: string) => {
  await db
    .delete(clients)
    .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)));
};

// ─── Client Contacts ──────────────────────────────────────────────────────────

export const getClientContacts = async (clientId: string, organizationId: string) => {
  return db
    .select()
    .from(clientContacts)
    .where(
      and(
        eq(clientContacts.clientId, clientId),
        eq(clientContacts.organizationId, organizationId),
      ),
    )
    .orderBy(asc(clientContacts.type));
};

export const addClientContact = async (
  clientId: string,
  organizationId: string,
  data: typeof clientContacts.$inferInsert,
) => {
  await checkContactDuplicate(organizationId, data.email);

  const [contact] = await db
    .insert(clientContacts)
    .values({ ...data, clientId, organizationId })
    .returning();
  return contact;
};

export const updateClientContact = async (
  contactId: string,
  clientId: string,
  organizationId: string,
  data: Partial<typeof clientContacts.$inferInsert>,
) => {
  if (data.email) await checkContactDuplicate(organizationId, data.email, contactId);

  const [updated] = await db
    .update(clientContacts)
    .set({ ...data, updatedAt: new Date() })
    .where(
      and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, clientId),
        eq(clientContacts.organizationId, organizationId),
      ),
    )
    .returning();
  return updated ?? null;
};

export const deleteClientContact = async (
  contactId: string,
  clientId: string,
  organizationId: string,
) => {
  const contacts = await getClientContacts(clientId, organizationId);
  const target = contacts.find((c) => c.id === contactId);
  if (!target) throw new NotFoundError("Contact not found");
  if (target.type === 'primary_client' && contacts.length === 1) {
    throw new ConflictError("Cannot remove the only primary contact");
  }
  await db
    .delete(clientContacts)
    .where(
      and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, clientId),
        eq(clientContacts.organizationId, organizationId),
      ),
    );
};

// ─── Client Companies ─────────────────────────────────────────────────────────

export const getClientCompany = async (clientId: string, organizationId: string) => {
  const [company] = await db
    .select()
    .from(clientCompanies)
    .where(
      and(
        eq(clientCompanies.clientId, clientId),
        eq(clientCompanies.organizationId, organizationId),
      ),
    );
  return company ?? null;
};

export const upsertClientCompany = async (
  clientId: string,
  organizationId: string,
  data: Omit<typeof clientCompanies.$inferInsert, 'id' | 'clientId' | 'organizationId' | 'createdAt' | 'updatedAt'>,
) => {
  const existing = await getClientCompany(clientId, organizationId);
  if (existing) {
    const [updated] = await db
      .update(clientCompanies)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(clientCompanies.clientId, clientId))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(clientCompanies)
    .values({ ...data, clientId, organizationId })
    .returning();
  return created;
};

// ─── Cases ────────────────────────────────────────────────────────────────────

export const getClientCases = async (
  clientId: string,
  organizationId: string,
  options: (Partial<PaginationParams> & { all?: boolean }) = {},
) => {
  const where = and(eq(cases.clientId, clientId), eq(cases.organizationId, organizationId));

  if (options.all) {
    return db.select().from(cases).where(where).orderBy(desc(cases.createdAt));
  }

  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [{ total }] = await db.select({ total: count() }).from(cases).where(where);
  const rows = await db
    .select()
    .from(cases)
    .where(where)
    .orderBy(desc(cases.createdAt))
    .limit(limit)
    .offset(offset);

  return buildPaginatedResponse(rows, { page, limit, total: Number(total) });
};

// ─── Certifications ───────────────────────────────────────────────────────────

export const getCertifications = async () => {
  const rows = await db.select().from(certifications);
  return rows.reduce(
    (acc, row) => {
      if (!acc[row.level]) acc[row.level] = [];
      acc[row.level].push({ code: row.id, name: row.name });
      return acc;
    },
    {} as Record<string, { code: string; name: string }[]>,
  );
};

// ─── Team staff for case assignment ──────────────────────────────────────────

export const getTeamStaff = async (teamId: string, organizationId: string) => {
  return db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(staff)
    .innerJoin(teamMembers, eq(teamMembers.staffId, staff.id))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(staff.organizationId, organizationId),
      ),
    );
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

const checkContactDuplicate = async (
  organizationId: string,
  email: string,
  excludeId?: string,
) => {
  const rows = await db
    .select({ id: clientContacts.id })
    .from(clientContacts)
    .where(and(eq(clientContacts.organizationId, organizationId), eq(clientContacts.email, email)));

  const match = rows.find((r) => r.id !== excludeId);
  if (match) {
    throw new ConflictError("A contact with this email address already exists at this firm");
  }
};

export class ClientsService {
  getAllClients = getAllClients;
  getClientById = getClientById;
  updateClient = updateClient;
  deleteClient = deleteClient;
  getClientContacts = getClientContacts;
  addClientContact = addClientContact;
  updateClientContact = updateClientContact;
  deleteClientContact = deleteClientContact;
  getClientCompany = getClientCompany;
  upsertClientCompany = upsertClientCompany;
  getClientCases = getClientCases;
  getCertifications = getCertifications;
  getTeamStaff = getTeamStaff;
}
