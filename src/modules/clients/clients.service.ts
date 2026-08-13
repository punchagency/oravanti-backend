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
  sql,
} from "drizzle-orm";
import { db, systemDb } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { certifications } from "../../db/schema/cases";
import { clientCompanies } from "../../db/schema/client-companies";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { practiceAreas } from "../../db/schema/practice-areas";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { staff } from "../../db/schema/staff";
import { teamMembers } from "../../db/schema/team-members";
import { organization, user, session } from "../../db/schema/auth-schema";
import { auth } from "../../auth";
import { env } from "../../config/env";
import { symmetricEncrypt, symmetricDecrypt } from "better-auth/crypto";
import { emailService } from "../../utils/email/email.service";
import { ConflictError, NotFoundError, BadRequestError } from "../../utils/error/app-error";
import { resolveAvatarUrl } from "../../utils/storage/avatar-url";
import { storageService } from "../../utils/storage/storage.service";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { db as _db } from "../../db/client";
import { generateCaseNumber } from "../cases/cases.service";
import { ensureCaseTypeBelongsToPracticeArea } from "../practice-areas/practice-areas.utils";

// ─── Clients (Legal Entities) ─────────────────────────────────────────────────

type ClientListOptions = Partial<PaginationParams> & {
  search?: string;
  all?: boolean;
  practiceAreaId?: string;
  portalStatus?: string;
};

// ─── Portal Types ────────────────────────────────────────────────────────────

export type ConvertedClientDTO = {
  id: string;
  entityType: string;
  displayName: string;
  status: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  clientCreatedAt: Date;
  leadId: string;
  leadSource: string;
  leadCreatedAt: Date;
  leadStatus: string;
  practiceAreaId: string | null;
  practiceAreaName: string | null;
  caseTypeId: string | null;
  caseTypeName: string | null;
  attorneyFirstName: string | null;
  attorneyLastName: string | null;
  convertedAt: Date | null;
  convertedCaseId: string | null;
  cases: { id: string; caseNumber: string; status: string; createdAt: Date }[];
  userId: string | null;
  hasPortalAccess: boolean;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  activeSessions: number;
};

export type PortalStatusDTO = {
  hasAccount: boolean;
  emailVerified: boolean;
  lastLoginAt: Date | null;
  activeSessionCount: number;
  accountStatus: "invited" | "active" | "disabled";
};

// ─── Standalone Functions ────────────────────────────────────────────────────

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

// ─── Service ──────────────────────────────────────────────────────────────────

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

  // ─── Converted Clients (Portal) ───────────────────────────────────────────

  async getClientProfile(userId: string) {
    const [row] = await db
      .select({
        id: clients.id,
        firstName: clients.firstName,
        lastName: clients.lastName,
        displayName: clients.displayName,
        email: clients.email,
        phone: clients.phone,
        avatarUrl: clients.avatarUrl,
        entityType: clients.entityType,
        status: clients.status,
        createdAt: clients.createdAt,
        updatedAt: clients.updatedAt,
      })
      .from(clients)
      .where(eq(clients.userId, userId))
      .limit(1);

    if (!row) return null;

    const avatarUrl = await resolveAvatarUrl(row.avatarUrl);

    return { ...row, avatarUrl };
  }

  async updateClientProfile(
    userId: string,
    data: { firstName?: string; lastName?: string; phone?: string | null },
  ) {
    const [existing] = await db
      .select({
        id: clients.id,
        firstName: clients.firstName,
        lastName: clients.lastName,
        displayName: clients.displayName,
        entityType: clients.entityType,
      })
      .from(clients)
      .where(eq(clients.userId, userId))
      .limit(1);

    if (!existing) return null;

    const firstName = data.firstName ?? existing.firstName;
    const lastName = data.lastName ?? existing.lastName;
    const displayName =
      existing.entityType === "individual"
        ? `${firstName} ${lastName}`.trim()
        : existing.displayName;

    const [updated] = await db
      .update(clients)
      .set({
        ...(data.firstName !== undefined ? { firstName } : {}),
        ...(data.lastName !== undefined ? { lastName } : {}),
        ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
        displayName,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, existing.id))
      .returning();

    return updated ?? null;
  }

  async uploadClientAvatar(
    userId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const [clientRecord] = await db
      .select({ id: clients.id, avatarUrl: clients.avatarUrl })
      .from(clients)
      .where(eq(clients.userId, userId))
      .limit(1);

    if (!clientRecord) return null;

    const ext = file.mimetype.split("/")[1] ?? "png";
    const key = `client-avatars/${clientRecord.id}.${ext}`;

    await storageService.upload({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    const avatarUrl = await storageService.getSignedDownloadUrl(key);

    // Persist the R2 key, not the signed URL — presigned URLs expire (1h) and
    // the browser fetches avatars directly from R2, so each read re-signs.
    await db
      .update(clients)
      .set({ avatarUrl: key, updatedAt: new Date() })
      .where(eq(clients.id, clientRecord.id));

    return { avatarUrl };
  }

  async listConvertedClients(
    organizationId: string,
    options: ClientListOptions = {},
  ) {
    const search = options.search?.trim();

    const conditions = [
      eq(clients.organizationId, organizationId),
      sql`${leads.convertedAt} IS NOT NULL`,
    ];

    if (search) {
      conditions.push(
        or(
          ilike(clients.displayName, `%${search}%`),
          ilike(clients.email, `%${search}%`),
          ilike(sql`${clients.firstName} || ' ' || ${clients.lastName}`, `%${search}%`),
        )!,
      );
    }

    if (options.practiceAreaId) {
      conditions.push(eq(leads.practiceAreaId, options.practiceAreaId));
    }

    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(clients)
      .innerJoin(leads, eq(leads.clientId, clients.id))
      .where(where);

    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    const rows = await db
      .select({
        id: clients.id,
        entityType: clients.entityType,
        displayName: clients.displayName,
        status: clients.status,
        firstName: clients.firstName,
        lastName: clients.lastName,
        email: clients.email,
        phone: clients.phone,
        clientCreatedAt: clients.createdAt,
        userId: clients.userId,
        leadId: leads.id,
        leadSource: leads.source,
        leadCreatedAt: leads.createdAt,
        leadStatus: leads.status,
        practiceAreaId: leads.practiceAreaId,
        practiceAreaName: practiceAreas.name,
        caseTypeId: leads.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        attorneyFirstName: staff.firstName,
        attorneyLastName: staff.lastName,
        convertedAt: leads.convertedAt,
        convertedCaseId: leads.convertedCaseId,
      })
      .from(clients)
      .innerJoin(leads, eq(leads.clientId, clients.id))
      .leftJoin(practiceAreas, eq(practiceAreas.id, leads.practiceAreaId))
      .leftJoin(practiceAreaCaseTypes, eq(practiceAreaCaseTypes.id, leads.caseTypeId))
      .leftJoin(staff, eq(staff.id, leads.assignedStaffId))
      .where(where)
      .orderBy(desc(leads.convertedAt))
      .limit(limit)
      .offset(offset);

    const enriched = await this.enrichWithCasesAndPortal(rows);

    let filtered = enriched;
    if (options.portalStatus && options.portalStatus !== "all") {
      filtered = enriched.filter((row) => {
        if (options.portalStatus === "active") return row.hasPortalAccess && row.activeSessions > 0;
        if (options.portalStatus === "invited") return row.hasPortalAccess && row.activeSessions === 0;
        if (options.portalStatus === "no_access") return !row.hasPortalAccess;
        return true;
      });
    }

    return buildPaginatedResponse(filtered, {
      page,
      limit,
      total: Number(total),
    });
  }

  async getConvertedClientDetail(
    clientId: string,
    organizationId: string,
  ): Promise<ConvertedClientDTO> {
    const [row] = await db
      .select({
        id: clients.id,
        entityType: clients.entityType,
        displayName: clients.displayName,
        status: clients.status,
        firstName: clients.firstName,
        lastName: clients.lastName,
        email: clients.email,
        phone: clients.phone,
        clientCreatedAt: clients.createdAt,
        userId: clients.userId,
        leadId: leads.id,
        leadSource: leads.source,
        leadCreatedAt: leads.createdAt,
        leadStatus: leads.status,
        practiceAreaId: leads.practiceAreaId,
        practiceAreaName: practiceAreas.name,
        caseTypeId: leads.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        attorneyFirstName: staff.firstName,
        attorneyLastName: staff.lastName,
        convertedAt: leads.convertedAt,
        convertedCaseId: leads.convertedCaseId,
      })
      .from(clients)
      .innerJoin(leads, eq(leads.clientId, clients.id))
      .leftJoin(practiceAreas, eq(practiceAreas.id, leads.practiceAreaId))
      .leftJoin(practiceAreaCaseTypes, eq(practiceAreaCaseTypes.id, leads.caseTypeId))
      .leftJoin(staff, eq(staff.id, leads.assignedStaffId))
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
          sql`${leads.convertedAt} IS NOT NULL`,
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundError("Client not found");

    const [result] = await this.enrichWithCasesAndPortal([row]);
    return result;
  }

  async sendPortalInvitation(
    clientId: string,
    organizationId: string,
    headers: Record<string, string>,
  ) {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
        ),
      );

    if (!client) throw new NotFoundError("Client not found");

    const fullName = client.displayName;

    // If user already exists, send magic link
    if (client.userId) {
      const [existingUser] = await systemDb
        .select({ id: user.id, email: user.email })
        .from(user)
        .where(eq(user.id, client.userId))
        .limit(1);

      if (existingUser) {
        // Ensure portal status is active
        await db
          .update(clients)
          .set({ portalStatus: "active", updatedAt: new Date() })
          .where(eq(clients.id, clientId));

        return {
          invited: true,
          sentAt: new Date().toISOString(),
          email: client.email,
          resent: true,
        };
      }
    }

    // Create user via Better Auth with a temporary password
    const tempPassword = this.generateTempPassword();

    try {
      const result = await auth.api.signUpEmail({
        body: {
          name: fullName,
          email: client.email,
          password: tempPassword,
          accountType: "client",
          onboardingState: "completed",
          callbackURL: env.EMAIL_VERIFICATION_CALLBACK_URL,
        },
        headers: headers as any,
      });

      if (result?.user) {
        // Set accountType to client
        await systemDb
          .update(user)
          .set({ accountType: "client" })
          .where(eq(user.id, result.user.id));

        // Add user as organization member with "client" role
        const orgId = client.organizationId;
        if (orgId) {
          await auth.api.addMember({
            body: {
              userId: result.user.id,
              role: "client",
              organizationId: orgId,
            },
            headers: headers as any,
          });
        }

        // Link user to the client record + store temp password + set portal active
        const encryptedPassword = await symmetricEncrypt({
          key: env.BETTER_AUTH_SECRET,
          data: tempPassword,
        });
        await db
          .update(clients)
          .set({
            userId: result.user.id,
            tempPassword: encryptedPassword,
            portalStatus: "active",
            updatedAt: new Date(),
          })
          .where(eq(clients.id, clientId));

        // Send invitation email with login credentials
        const [orgRecord] = await db
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, client.organizationId))
          .limit(1);

        const loginUrl = `${env.FRONTEND_APP_URL || "http://localhost:5173"}/login?email=${encodeURIComponent(client.email)}&password=${encodeURIComponent(tempPassword)}`;

        await emailService.sendInvitationWithCredentials({
          email: client.email,
          tempPassword,
          inviteLink: loginUrl,
          invitedByUsername: "Your team",
          invitedByEmail: "",
          orgName: orgRecord?.name ?? "your organization",
        });

        return {
          invited: true,
          sentAt: new Date().toISOString(),
          email: client.email,
        };
      }
    } catch (error: any) {
      // If user already exists (race condition), link them and resend
      if (error?.message?.includes("already exists") || error?.status === 409) {
        const [existingUser] = await systemDb
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, client.email))
          .limit(1);

        if (existingUser) {
          await db
            .update(clients)
            .set({ userId: existingUser.id, updatedAt: new Date() })
            .where(eq(clients.id, clientId));

          return {
            invited: true,
            sentAt: new Date().toISOString(),
            email: client.email,
            resent: true,
          };
        }
      }
      throw error;
    }

    throw new BadRequestError("Failed to send invitation");
  }

  async getClientSessions(
    clientId: string,
    organizationId: string,
  ) {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
        ),
      );

    if (!client) throw new NotFoundError("Client not found");
    if (!client.userId) return [];

    const sessions = await systemDb
      .select({
        id: session.id,
        token: session.token,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, client.userId))
      .orderBy(desc(session.createdAt));

    return sessions;
  }

  async revokeClientSession(
    clientId: string,
    token: string,
    organizationId: string,
  ) {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
        ),
      );

    if (!client) throw new NotFoundError("Client not found");
    if (!client.userId) throw new BadRequestError("Client does not have a portal account");

    const [deleted] = await systemDb
      .delete(session)
      .where(
        and(
          eq(session.userId, client.userId),
          eq(session.token, token),
        ),
      )
      .returning();

    if (!deleted) throw new NotFoundError("Session not found");

    return { revoked: true };
  }

  async getPortalStatus(
    clientId: string,
    organizationId: string,
  ): Promise<PortalStatusDTO> {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
        ),
      );

    if (!client) throw new NotFoundError("Client not found");

    if (!client.userId) {
      return {
        hasAccount: false,
        emailVerified: false,
        lastLoginAt: null,
        activeSessionCount: 0,
        accountStatus: "invited" as const,
      };
    }

    const [userRecord] = await systemDb
      .select({
        emailVerified: user.emailVerified,
      })
      .from(user)
      .where(eq(user.id, client.userId))
      .limit(1);

    const [{ activeCount }] = await systemDb
      .select({ activeCount: count() })
      .from(session)
      .where(
        and(
          eq(session.userId, client.userId),
          sql`${session.expiresAt} > NOW()`,
        ),
      );

    let accountStatus: "invited" | "active" | "disabled" = "invited";

    // Check portalStatus column first
    if (client.portalStatus === "disabled") {
      accountStatus = "disabled";
    } else if (userRecord) {
      if (Number(activeCount) > 0 || userRecord.emailVerified) {
        accountStatus = "active";
      }
    }

    const [lastSession] = await systemDb
      .select({ createdAt: session.createdAt })
      .from(session)
      .where(eq(session.userId, client.userId))
      .orderBy(desc(session.createdAt))
      .limit(1);

    return {
      hasAccount: !!userRecord,
      emailVerified: userRecord?.emailVerified ?? false,
      lastLoginAt: lastSession?.createdAt ?? null,
      activeSessionCount: Number(activeCount),
      accountStatus,
    };
  }

  async updatePortalStatus(
    clientId: string,
    organizationId: string,
    status: "none" | "pending" | "active" | "disabled",
  ) {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.organizationId, organizationId),
        ),
      );

    if (!client) throw new NotFoundError("Client not found");

    await db
      .update(clients)
      .set({ portalStatus: status, updatedAt: new Date() })
      .where(eq(clients.id, clientId));

    return { clientId, portalStatus: status };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private async enrichWithCasesAndPortal(
    rows: any[],
  ): Promise<ConvertedClientDTO[]> {
    if (rows.length === 0) return [];

    const clientIds = rows.map((r) => r.id);

    const clientCases = await db
      .select({
        clientId: cases.clientId,
        id: cases.id,
        caseNumber: cases.caseNumber,
        status: cases.status,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .where(sql`${cases.clientId} IN ${clientIds}`)
      .orderBy(desc(cases.createdAt));

    const casesByClient = new Map<string, typeof clientCases>();
    for (const c of clientCases) {
      if (!casesByClient.has(c.clientId)) casesByClient.set(c.clientId, []);
      casesByClient.get(c.clientId)!.push(c);
    }

    const userIds = rows.filter((r) => r.userId).map((r) => r.userId);
    const portalInfo = new Map<string, { emailVerified: boolean; activeSessions: number; lastLoginAt: Date | null }>();

    if (userIds.length > 0) {
      const users = await systemDb
        .select({ id: user.id, emailVerified: user.emailVerified })
        .from(user)
        .where(sql`${user.id} IN ${userIds}`);

      for (const u of users) {
        const [{ activeCount }] = await systemDb
          .select({ activeCount: count() })
          .from(session)
          .where(
            and(
              eq(session.userId, u.id),
              sql`${session.expiresAt} > NOW()`,
            ),
          );

        const [lastSession] = await systemDb
          .select({ createdAt: session.createdAt })
          .from(session)
          .where(eq(session.userId, u.id))
          .orderBy(desc(session.createdAt))
          .limit(1);

        portalInfo.set(u.id, {
          emailVerified: u.emailVerified,
          activeSessions: Number(activeCount),
          lastLoginAt: lastSession?.createdAt ?? null,
        });
      }
    }

    return rows.map((row) => {
      const portal = row.userId ? portalInfo.get(row.userId) : null;
      return {
        ...row,
        cases: casesByClient.get(row.id) ?? [],
        hasPortalAccess: !!portal,
        emailVerified: portal?.emailVerified ?? false,
        lastLoginAt: portal?.lastLoginAt ?? null,
        activeSessions: portal?.activeSessions ?? 0,
      };
    });
  }

  private generateTempPassword(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  private generateClientInvitationTemplate({
    clientName,
    email,
    tempPassword,
    loginUrl,
  }: {
    clientName: string;
    email: string;
    tempPassword: string;
    loginUrl: string;
  }): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #374151; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb;">
        <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase;">
          Ov
        </div>
        <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px;">
          Welcome to Oravanti
        </h2>
        <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          Hi ${clientName}, your client portal account has been created. Use the credentials below to sign in.
        </p>
        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: left;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Email</p>
          <p style="margin: 0 0 16px; font-size: 15px; font-weight: 600; color: #1f2937;">${email}</p>
          <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Temporary password</p>
          <p style="margin: 0; font-size: 15px; font-weight: 600; color: #1f2937; font-family: 'Courier New', monospace; letter-spacing: 1px;">${tempPassword}</p>
        </div>
        <p style="color: #ef4444; font-size: 13px; line-height: 1.5; margin-bottom: 24px;">
          For security, you will be required to set a new password after logging in.
        </p>
        <div style="margin-bottom: 16px;">
          <a href="${loginUrl}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block;">
            Sign In to Portal
          </a>
        </div>
        <p style="color: #9ca3af; font-size: 12px; line-height: 1.5;">
          If you did not expect this invitation, you can safely ignore this email.
        </p>
      </div>
    `;
  }

  private generatePasswordResetTemplate({
    clientName,
    resetUrl,
  }: {
    clientName: string;
    resetUrl: string;
  }): string {
    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #374151; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb;">
        <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase;">
          Ov
        </div>
        <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px;">
          Reset Your Password
        </h2>
        <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          Hi ${clientName}, click the button below to set a new password for your client portal account.
        </p>
        <div style="margin-bottom: 24px;">
          <a href="${resetUrl}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color: #9ca3af; font-size: 12px; line-height: 1.5;">
          If you did not request this, you can safely ignore this email.
        </p>
      </div>
    `;
  }
}
