import { and, eq, inArray, sql } from "drizzle-orm";
import { db, systemDb } from "../../../db/client";
import { organization, team, user } from "../../../db/schema/auth-schema";
import { profiles } from "../../../db/schema/profiles";
import { companies } from "../../../db/schema/companies";
import { connectedEmailAccount } from "../../../db/schema/email";
import {
  adminSessions,
  admins,
  adverseParties,
  aiScanJobs,
  aiSystemConfig,
  assignments,
  calendarEvents,
  caseIssues,
  cases,
  caseNotes,
  caseTypeDocumentRequirements,
  caseWorkflowSteps,
  clientCompanies,
  clientContacts,
  clientRequests,
  clients,
  conflictChecks,
  consultationLocations,
  consultationParticipants,
  consultationSettings,
  consultations,
  documentAccess,
  documentCaseLinks,
  documentRequests,
  documents,
  documentVersions,
  externalSubmissions,
  feeAgreements,
  financialAccessControls,
  firmPracticeAreas,
  firmQuestionnaireLogicRules,
  firmQuestionnaireQuestions,
  firmQuestionnaireSections,
  leadDocumentLinks,
  leadNotes,
  leadTasks,
  leads,
  leaveRequests,
  paralegalProfiles,
  questionnaireAnswers,
  questionnaireResponseFiles,
  questionnaireResponses,
  questionnaireSends,
  scenarioDocumentRequirements,
  staff,
  staffAvailability,
  staffAvailabilityBreaks,
  staffAvailabilityOverrides,

  subscriptions,
  SubscriptionStatus,
  tasks,
  timeEntries,

} from "../../../db/schema";
import { recordAuditEvent } from "../../shared/audit.service";
import { getFirmTimezone } from "../consultation/consultation-settings.service";
import { storageService } from "../../../utils/storage/storage.service";
import { BadRequestError } from "../../../utils/error/app-error";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("firm-profile.service");

const DEFAULT_COUNTRY = "United States";

export interface FirmProfileDTO {
  id: string;
  organizationId: string;
  firmLegalName: string;
  displayName: string;
  tagline: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  timezone: string;
  country: string;
  barNumber: string | null;
  jurisdiction: string | null;
  practiceType: string | null;
  foundedYear: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFirmProfileInput {
  firmLegalName?: string;
  displayName?: string;
  tagline?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  timezone?: string;
  country?: string | null;
  barNumber?: string | null;
  jurisdiction?: string | null;
  practiceType?: string | null;
  foundedYear?: number | null;
}

export interface FirmSnapshotDTO {
  logoUrl: string | null;
  plan: string;
  activeAddons: number;
  staffCount: number;
  foundedYear: number | null;
  jurisdiction: string | null;
}

/**
 * Firm profile settings (General tab).
 *
 * Core identity fields live on the `organization` row (the single source of
 * truth also written during onboarding and consumed by `firm-info`); the firm
 * timezone lives on `consultation_settings` (where the rest of the app already
 * resolves it). The DTO below merges them into the shape the settings UI uses.
 */
export class FirmProfileService {
  getProfile = async (organizationId: string): Promise<FirmProfileDTO> => {
    const [org] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    if (!org) {
      throw new BadRequestError("Organization not found");
    }

    const timezone = await getFirmTimezone(organizationId);

    return {
      id: org.id,
      organizationId: org.id,
      firmLegalName: org.name,
      displayName: org.displayName ?? org.name,
      tagline: org.tagline,
      phone: org.phoneNumber,
      email: org.emailAddress,
      website: org.website,
      streetAddress: org.address,
      city: org.city,
      state: org.state,
      zipCode: org.zipCode,
      timezone,
      country: org.country ?? DEFAULT_COUNTRY,
      barNumber: org.barNumber,
      jurisdiction: org.jurisdiction,
      practiceType: org.practiceType,
      foundedYear: org.foundedYear,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.createdAt.toISOString(),
    };
  };

  updateProfile = async (
    organizationId: string,
    body: UpdateFirmProfileInput,
  ): Promise<FirmProfileDTO> => {
    const { timezone, ...orgFields } = body;

    const updateData: Record<string, unknown> = {};

    if (orgFields.firmLegalName !== undefined) {
      updateData.name = orgFields.firmLegalName;
    }
    if (orgFields.displayName !== undefined) {
      updateData.displayName = orgFields.displayName;
    }
    if (orgFields.tagline !== undefined) {
      updateData.tagline = orgFields.tagline || null;
    }
    if (orgFields.phone !== undefined) {
      updateData.phoneNumber = orgFields.phone || null;
    }
    if (orgFields.email !== undefined) {
      updateData.emailAddress = orgFields.email || null;
    }
    if (orgFields.website !== undefined) {
      updateData.website = orgFields.website || null;
    }
    if (orgFields.streetAddress !== undefined) {
      updateData.address = orgFields.streetAddress || null;
    }
    if (orgFields.city !== undefined) {
      updateData.city = orgFields.city || null;
    }
    if (orgFields.state !== undefined) {
      updateData.state = orgFields.state || null;
    }
    if (orgFields.zipCode !== undefined) {
      updateData.zipCode = orgFields.zipCode || null;
    }
    if (orgFields.country !== undefined) {
      updateData.country = orgFields.country || null;
    }
    if (orgFields.barNumber !== undefined) {
      updateData.barNumber = orgFields.barNumber || null;
    }
    if (orgFields.jurisdiction !== undefined) {
      updateData.jurisdiction = orgFields.jurisdiction || null;
    }
    if (orgFields.practiceType !== undefined) {
      updateData.practiceType = orgFields.practiceType || null;
    }
    if (orgFields.foundedYear !== undefined) {
      updateData.foundedYear = orgFields.foundedYear || null;
    }

    await db
      .update(organization)
      .set(updateData)
      .where(eq(organization.id, organizationId));

    // The firm timezone is owned by consultation_settings (single source used
    // app-wide for scheduling/reporting). Upsert it alongside the profile.
    if (timezone !== undefined) {
      const [existing] = await db
        .select()
        .from(consultationSettings)
        .where(eq(consultationSettings.organizationId, organizationId))
        .limit(1);

      if (existing) {
        await db
          .update(consultationSettings)
          .set({ timezone, updatedAt: new Date() })
          .where(eq(consultationSettings.organizationId, organizationId));
      } else {
        await db.insert(consultationSettings).values({
          organizationId,
          timezone,
        });
      }
    }

    log.action("settings.firm_profile_updated", { organizationId });
    return this.getProfile(organizationId);
  };

  getSnapshot = async (organizationId: string): Promise<FirmSnapshotDTO> => {
    const [org] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    const [staffCountRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(staff)
      .where(eq(staff.organizationId, organizationId));

    const [addonsRow] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organizationId, organizationId),
          eq(subscriptions.status, SubscriptionStatus.ACTIVE),
        ),
      );

    return {
      logoUrl: await this.signLogoUrl(org?.logo ?? null),
      plan: "Complete",
      activeAddons: addonsRow?.count ?? 0,
      staffCount: staffCountRow?.count ?? 0,
      foundedYear: org?.foundedYear ?? null,
      jurisdiction: org?.jurisdiction ?? null,
    };
  };

  private async signLogoUrl(logo: string | null): Promise<string | null> {
    if (!logo) return null;
    // `organization.logo` stores the R2 object key (white-label uploads); sign
    // it on read. Legacy full URLs are returned unchanged.
    if (/^https?:\/\//.test(logo)) return logo;
    try {
      return await storageService.getSignedDownloadUrl(logo);
    } catch {
      return null;
    }
  };

  exportFirmData = async (organizationId: string) => {
    const profile = await this.getProfile(organizationId);

    const [consultation] = await db
      .select()
      .from(consultationSettings)
      .where(eq(consultationSettings.organizationId, organizationId))
      .limit(1);

    const staffList = await db
      .select({
        id: staff.id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        role: staff.role,
        status: staff.status,
        jobTitle: staff.jobTitle,
        barNumber: staff.barNumber,
        phone: staff.phone,
      })
      .from(staff)
      .where(eq(staff.organizationId, organizationId));

    const teams = await db
      .select({
        id: team.id,
        name: team.name,
        description: team.description,
        status: team.status,
        leadId: team.leadId,
      })
      .from(team)
      .where(eq(team.organizationId, organizationId));

    const payload = {
      exportedAt: new Date().toISOString(),
      firmProfile: profile,
      consultationSettings: consultation
        ? {
            chargesFee: consultation.chargesFee,
            defaultAmount:
              consultation.defaultAmount != null
                ? Number(consultation.defaultAmount)
                : null,
            feeStructure: consultation.feeStructure,
            waiverWindowDays: consultation.waiverWindowDays,
            timezone: consultation.timezone,
            smsEnabled: consultation.smsEnabled,
          }
        : null,
      staff: staffList,
      teams,
    };

    const timestamp = Date.now();
    const key = `exports/${organizationId}/${timestamp}-firm-data.json`;
    await storageService.upload({
      key,
      body: Buffer.from(JSON.stringify(payload, null, 2)),
      contentType: "application/json",
    });

    const downloadUrl = await storageService.getSignedDownloadUrl(key);
    return { downloadUrl };
  };

  /**
   * Delete the firm account and all of its data.
   *
   * Strategy:
   * - Rows are removed in dependency order inside a tenant-scoped transaction
   *   (children before parents) so FK constraints are satisfied. Tables that
   *   carry an `organization_id` are filtered directly; the document family and
   *   join tables (no `organization_id`) are resolved by ids gathered from the
   *   org's cases/leads.
   * - Tables that reference org-scoped parents with `onDelete: cascade`
   *   (e.g. case events/notes, client notes, team members, member/invitation)
   *   are cleaned up by those cascades and are not listed here.
   * - `profiles`, `user` (auth) and the `organization` row itself are removed
   *   afterwards via `systemDb` (auth/system teardown, not RLS-scoped).
   */
  deleteFirmAccount = async (organizationId: string) => {
    const staffRows = await db
      .select({ userId: staff.userId })
      .from(staff)
      .where(eq(staff.organizationId, organizationId));

    const staffUserIds = staffRows
      .map((row) => row.userId)
      .filter((id): id is string => !!id);

    const orgCaseIds = (
      await db
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.organizationId, organizationId))
    ).map((row) => row.id);

    const orgLeadIds = (
      await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.organizationId, organizationId))
    ).map((row) => row.id);

    const caseLinkDocIds = orgCaseIds.length
      ? (
          await db
            .select({ documentId: documentCaseLinks.documentId })
            .from(documentCaseLinks)
            .where(inArray(documentCaseLinks.caseId, orgCaseIds))
        ).map((row) => row.documentId)
      : [];

    const leadLinkDocIds = orgLeadIds.length
      ? (
          await db
            .select({ documentId: leadDocumentLinks.documentId })
            .from(leadDocumentLinks)
            .where(inArray(leadDocumentLinks.leadId, orgLeadIds))
        ).map((row) => row.documentId)
      : [];

    const docIds = [...new Set([...caseLinkDocIds, ...leadLinkDocIds])];

    const requestIds = orgCaseIds.length
      ? (
          await db
            .select({ id: documentRequests.id })
            .from(documentRequests)
            .where(inArray(documentRequests.caseId, orgCaseIds))
        ).map((row) => row.id)
      : [];

    const inIds = <T,>(column: any, ids: T[]) =>
      ids.length ? inArray(column, ids) : sql`false`;

    await db.transaction(async (tx) => {
      const del = (table: any, where: any) =>
        tx.delete(table).where(where);

      // ── Questionnaires (reference clients/leads/cases without cascade) ──
      await del(questionnaireResponseFiles, eq(questionnaireResponseFiles.organizationId, organizationId));
      await del(questionnaireAnswers, eq(questionnaireAnswers.organizationId, organizationId));
      await del(questionnaireResponses, eq(questionnaireResponses.organizationId, organizationId));
      await del(questionnaireSends, eq(questionnaireSends.organizationId, organizationId));
      await del(firmQuestionnaireLogicRules, eq(firmQuestionnaireLogicRules.organizationId, organizationId));
      await del(firmQuestionnaireQuestions, eq(firmQuestionnaireQuestions.organizationId, organizationId));
      await del(firmQuestionnaireSections, eq(firmQuestionnaireSections.organizationId, organizationId));



      // ── Leads & consultations ──
      await del(leadTasks, eq(leadTasks.organizationId, organizationId));
      // `lead_events` used to be deleted here. Its replacement, `audit_events`,
      // is deliberately NOT — the record of what a firm did survives the firm
      // erasing its data, which is the entire point of a retained audit trail.
      // See the `admin.firm_data_reset` event written at the end of this method.
      await del(leadNotes, inIds(leadNotes.leadId, orgLeadIds));
      await del(consultationParticipants, eq(consultationParticipants.organizationId, organizationId));
      await del(consultations, eq(consultations.organizationId, organizationId));
      await del(consultationLocations, eq(consultationLocations.organizationId, organizationId));

      // ── Document family & case/lead-linked rows (resolved by id) ──
      await del(caseTypeDocumentRequirements, eq(caseTypeDocumentRequirements.organizationId, organizationId));
      await del(scenarioDocumentRequirements, eq(scenarioDocumentRequirements.organizationId, organizationId));
      await del(caseIssues, eq(caseIssues.organizationId, organizationId));
      await del(externalSubmissions, inIds(externalSubmissions.requestId, requestIds));
      await del(documentRequests, inIds(documentRequests.id, requestIds));
      await del(documentAccess, inIds(documentAccess.documentId, docIds));
      await del(documentVersions, inIds(documentVersions.documentId, docIds));
      await del(leadDocumentLinks, inIds(leadDocumentLinks.leadId, orgLeadIds));
      await del(documentCaseLinks, inIds(documentCaseLinks.caseId, orgCaseIds));
      await del(documents, inIds(documents.id, docIds));
      await del(adverseParties, eq(adverseParties.organizationId, organizationId));
      await del(conflictChecks, eq(conflictChecks.organizationId, organizationId));

      // ── Core entities ──
      await del(clientCompanies, eq(clientCompanies.organizationId, organizationId));
      await del(clientContacts, eq(clientContacts.organizationId, organizationId));
      await del(clientRequests, eq(clientRequests.organizationId, organizationId));
      await del(clients, eq(clients.organizationId, organizationId));
      await del(leads, eq(leads.organizationId, organizationId));
      await del(cases, eq(cases.organizationId, organizationId));

      // ── Remaining org-scoped settings/access/operations ──
      await del(feeAgreements, eq(feeAgreements.organizationId, organizationId));
      await del(calendarEvents, eq(calendarEvents.organizationId, organizationId));
      await del(assignments, eq(assignments.organizationId, organizationId));
      await del(timeEntries, eq(timeEntries.organizationId, organizationId));
      await del(caseWorkflowSteps, eq(caseWorkflowSteps.organizationId, organizationId));
      await del(caseNotes, eq(caseNotes.organizationId, organizationId));
      await del(tasks, eq(tasks.organizationId, organizationId));
      await del(financialAccessControls, eq(financialAccessControls.organizationId, organizationId));
      await del(paralegalProfiles, eq(paralegalProfiles.organizationId, organizationId));
      await del(staffAvailabilityOverrides, eq(staffAvailabilityOverrides.organizationId, organizationId));
      await del(staffAvailabilityBreaks, eq(staffAvailabilityBreaks.organizationId, organizationId));
      await del(staffAvailability, eq(staffAvailability.organizationId, organizationId));
      await del(leaveRequests, eq(leaveRequests.organizationId, organizationId));
      await del(subscriptions, eq(subscriptions.organizationId, organizationId));
      await del(firmPracticeAreas, eq(firmPracticeAreas.organizationId, organizationId));
      await del(aiScanJobs, eq(aiScanJobs.organizationId, organizationId));
      await del(aiSystemConfig, eq(aiSystemConfig.organizationId, organizationId));
      await del(connectedEmailAccount, eq(connectedEmailAccount.organizationId, organizationId));
      await del(adminSessions, eq(adminSessions.organizationId, organizationId));
      await del(admins, eq(admins.organizationId, organizationId));
      await del(companies, eq(companies.organizationId, organizationId));
      await del(team, eq(team.organizationId, organizationId));

      await del(staff, eq(staff.organizationId, organizationId));
    });

    // The most destructive operation in the system, and until now the only one
    // that left no trace — it deleted six audit tables and wrote nothing about
    // itself. Recorded before the organization row goes, and deliberately
    // outside the transaction above so it is not rolled back with a partial
    // failure: an attempted reset is as much worth knowing about as a
    // completed one.
    await recordAuditEvent({
      action: "admin.firm_data_reset",
      entityId: organizationId,
      organizationId,
      summary: `Firm account and all tenant data deleted for ${organizationId}`,
      metadata: {
        staffAccountsRemoved: staffUserIds.length,
        leadsRemoved: orgLeadIds.length,
        casesRemoved: orgCaseIds.length,
        documentsRemoved: docIds.length,
      },
      // The org is about to cease to exist, so a failure here cannot be undone
      // by rolling anything back — but it must not silently disappear either.
      onWriteFailure: "log",
    });

    // Auth/system rows — deleted outside the tenant transaction (not RLS-scoped).
    if (staffUserIds.length > 0) {
      await systemDb
        .delete(profiles)
        .where(inArray(profiles.userId, staffUserIds));
      await systemDb.delete(user).where(inArray(user.id, staffUserIds));
    }

    await systemDb
      .delete(organization)
      .where(eq(organization.id, organizationId));

    return { message: "Firm account deleted" };
  };
}
