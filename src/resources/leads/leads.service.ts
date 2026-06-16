import { createHash, randomBytes } from "crypto";
import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import { emailService } from "../../utils/email/email.service";
import { db } from "../../db/client";
import { adverseParties } from "../../db/schema/adverse-parties";
import { clientCompanies } from "../../db/schema/client-companies";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { conflictChecks } from "../../db/schema/conflict-checks";
import { consultations } from "../../db/schema/consultations";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { leads } from "../../db/schema/leads";
import { cases } from "../../db/schema/cases";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  caseTypeQuestionnaireQuestions,
  caseTypeQuestionnaireLogicRules,
  firmQuestionnaireSections,
  firmQuestionnaireQuestions,
  firmQuestionnaireLogicRules,
  questionnaireSends,
  questionnaireResponses,
} from "../../db/schema/questionnaires";
import { staff } from "../../db/schema/staff";
import { caseWorkflowSteps, workflowTemplates, workflowTemplateSteps } from "../../db/schema/workflow";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { stubESignatureProvider } from "./esignature.provider";
import { generateCaseNumber } from "../cases/cases.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const generateAccessToken = () => randomBytes(32).toString("base64url");

const normalizeName = (name: string) => name.trim().toLowerCase();

// ─── Questionnaire Snapshot Builder ──────────────────────────────────────────

const buildSchemaSnapshot = async (
  organizationId: string,
  caseTypeQuestionnaireId: string,
) => {
  const [questionnaire] = await db
    .select()
    .from(caseTypeQuestionnaires)
    .where(eq(caseTypeQuestionnaires.id, caseTypeQuestionnaireId))
    .limit(1);

  if (!questionnaire) return null;

  const systemSections = await db
    .select()
    .from(caseTypeQuestionnaireSections)
    .where(eq(caseTypeQuestionnaireSections.questionnaireId, caseTypeQuestionnaireId));

  const systemQuestions = await db
    .select()
    .from(caseTypeQuestionnaireQuestions)
    .where(eq(caseTypeQuestionnaireQuestions.questionnaireId, caseTypeQuestionnaireId));

  const systemLogicRules = await db
    .select()
    .from(caseTypeQuestionnaireLogicRules)
    .where(eq(caseTypeQuestionnaireLogicRules.questionnaireId, caseTypeQuestionnaireId));

  const firmSections = await db
    .select()
    .from(firmQuestionnaireSections)
    .where(
      and(
        eq(firmQuestionnaireSections.organizationId, organizationId),
        eq(firmQuestionnaireSections.caseTypeId, questionnaire.caseTypeId),
      ),
    );

  const firmQs = await db
    .select()
    .from(firmQuestionnaireQuestions)
    .where(
      and(
        eq(firmQuestionnaireQuestions.organizationId, organizationId),
        eq(firmQuestionnaireQuestions.caseTypeId, questionnaire.caseTypeId),
      ),
    );

  const firmLogicRules = await db
    .select()
    .from(firmQuestionnaireLogicRules)
    .where(
      and(
        eq(firmQuestionnaireLogicRules.organizationId, organizationId),
        eq(firmQuestionnaireLogicRules.caseTypeId, questionnaire.caseTypeId),
      ),
    );

  const qBySection = new Map<string, typeof systemQuestions>();
  for (const q of systemQuestions) {
    const arr = qBySection.get(q.sectionId) ?? [];
    arr.push(q);
    qBySection.set(q.sectionId, arr);
  }

  const firmQBySystemSection = new Map<string, typeof firmQs>();
  const firmQByFirmSection = new Map<string, typeof firmQs>();
  for (const q of firmQs) {
    if (q.systemSectionId) {
      const arr = firmQBySystemSection.get(q.systemSectionId) ?? [];
      arr.push(q);
      firmQBySystemSection.set(q.systemSectionId, arr);
    } else if (q.firmSectionId) {
      const arr = firmQByFirmSection.get(q.firmSectionId) ?? [];
      arr.push(q);
      firmQByFirmSection.set(q.firmSectionId, arr);
    }
  }

  const builtSections = [
    ...systemSections
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => ({
        id: s.id,
        source: "system",
        title: s.title,
        description: s.description,
        questions: [
          ...(qBySection.get(s.id) ?? [])
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .map((q) => ({
              id: q.id,
              source: "system",
              label: q.label,
              description: q.description,
              type: q.type,
              orderIndex: q.orderIndex,
              isRequired: q.isRequired,
              config: q.config,
              isLocked: true,
            })),
          ...(firmQBySystemSection.get(s.id) ?? [])
            .sort((a, b) => a.orderIndex - b.orderIndex)
            .map((q) => ({
              id: q.id,
              source: "firm",
              label: q.label,
              description: q.description,
              type: q.type,
              orderIndex: q.orderIndex,
              isRequired: q.isRequired,
              config: q.config,
              isLocked: false,
            })),
        ],
      })),
    ...firmSections
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => ({
        id: s.id,
        source: "firm",
        title: s.title,
        description: s.description,
        questions: (firmQByFirmSection.get(s.id) ?? [])
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((q) => ({
            id: q.id,
            source: "firm",
            label: q.label,
            description: q.description,
            type: q.type,
            orderIndex: q.orderIndex,
            isRequired: q.isRequired,
            config: q.config,
            isLocked: false,
          })),
      })),
  ];

  return {
    title: questionnaire.title,
    description: questionnaire.description,
    sections: builtSections,
    logicRules: [
      ...systemLogicRules.map((r) => ({ ...r, source: "system" })),
      ...firmLogicRules.map((r) => ({ ...r, source: "firm" })),
    ],
  };
};

// ─── Leads CRUD ───────────────────────────────────────────────────────────────

export const createLead = async (
  organizationId: string,
  data: {
    name: string;
    email: string;
    phone?: string;
    entityType?: "individual" | "company";
    practiceAreaId?: string;
    caseTypeId?: string;
    source: string;
    situationSummary?: string;
    notes?: string;
    assignedStaffId?: string;
  },
) => {
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId,
      name: data.name,
      email: data.email,
      phone: data.phone,
      entityType: (data.entityType ?? "individual") as any,
      practiceAreaId: data.practiceAreaId,
      caseTypeId: data.caseTypeId,
      source: data.source as any,
      situationSummary: data.situationSummary,
      notes: data.notes,
      assignedStaffId: data.assignedStaffId,
    })
    .returning();

  return lead;
};

export const getAllLeads = async (
  organizationId: string,
  filters: Partial<PaginationParams> & {
    stage?: string;
    status?: string;
    practiceAreaId?: string;
    source?: string;
    search?: string;
    all?: boolean;
  } = {},
) => {
  const conditions = [eq(leads.organizationId, organizationId)];

  if (filters.stage) conditions.push(eq(leads.pipelineStage, filters.stage as any));
  if (filters.status) conditions.push(eq(leads.status, filters.status as any));
  if (filters.practiceAreaId) conditions.push(eq(leads.practiceAreaId, filters.practiceAreaId));
  if (filters.source) conditions.push(eq(leads.source, filters.source as any));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push(or(ilike(leads.name, q), ilike(leads.email, q))!);
  }

  const where = and(...conditions);

  if (filters.all) {
    return db
      .select()
      .from(leads)
      .where(where)
      .orderBy(desc(leads.receivedAt));
  }

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [countRow] = await db
    .select({ total: count() })
    .from(leads)
    .where(where);

  const rows = await db
    .select()
    .from(leads)
    .where(where)
    .orderBy(desc(leads.receivedAt))
    .limit(limit)
    .offset(offset);

  return buildPaginatedResponse(rows, { page, limit, total: Number(countRow?.total ?? 0) });
};

export const getLeadById = async (id: string, organizationId: string) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) return null;

  const [conflictCheck, questionnaireSend, consultation, feeAgreement] =
    await Promise.all([
      lead.conflictCheckId
        ? db
            .select()
            .from(conflictChecks)
            .where(eq(conflictChecks.id, lead.conflictCheckId))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
      lead.questionnaireSendId
        ? db
            .select()
            .from(questionnaireSends)
            .where(eq(questionnaireSends.id, lead.questionnaireSendId))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
      lead.consultationId
        ? db
            .select()
            .from(consultations)
            .where(eq(consultations.id, lead.consultationId))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
      lead.feeAgreementId
        ? db
            .select()
            .from(feeAgreements)
            .where(eq(feeAgreements.id, lead.feeAgreementId))
            .limit(1)
            .then(([r]) => r ?? null)
        : Promise.resolve(null),
    ]);

  return { ...lead, conflictCheck, questionnaireSend, consultation, feeAgreement };
};

export const updateLead = async (
  id: string,
  organizationId: string,
  data: Partial<{
    name: string;
    email: string;
    phone: string;
    practiceAreaId: string;
    caseTypeId: string;
    source: string;
    situationSummary: string;
    notes: string;
    assignedStaffId: string;
  }>,
) => {
  const [updated] = await db
    .update(leads)
    .set({ ...data, source: data.source as any, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead not found");
  return updated;
};

export const archiveLead = async (id: string, organizationId: string) => {
  const [updated] = await db
    .update(leads)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead not found");
  return updated;
};

// Stage transitions are validated here before updating
const STAGE_ORDER = [
  "lead_inbox",
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
] as const;

export const advanceLeadStage = async (
  id: string,
  organizationId: string,
  newStage: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const currentIdx = STAGE_ORDER.indexOf(lead.pipelineStage as any);
  const newIdx = STAGE_ORDER.indexOf(newStage as any);

  if (newIdx === -1) throw new BadRequestError(`Invalid stage: ${newStage}`);

  // Validate transition rules for forward moves
  if (newIdx > currentIdx) {
    if (newStage === "questionnaire" && lead.conflictCheckId) {
      const [cc] = await db
        .select()
        .from(conflictChecks)
        .where(eq(conflictChecks.id, lead.conflictCheckId))
        .limit(1);

      if (
        cc &&
        cc.status === "conflict_found" &&
        !cc.supervisorOverrideById
      ) {
        throw new ConflictError(
          "Conflict found — supervisor override required before advancing to questionnaire",
        );
      }
    }

    if (newStage === "case_opening") {
      if (lead.feeAgreementId) {
        const [fa] = await db
          .select()
          .from(feeAgreements)
          .where(eq(feeAgreements.id, lead.feeAgreementId))
          .limit(1);
        if (!fa || fa.status !== "signed") {
          throw new ConflictError("Fee agreement must be signed before opening a case");
        }
      }
    }
  }

  const [updated] = await db
    .update(leads)
    .set({ pipelineStage: newStage as any, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  return updated;
};

// ─── Conflict Check ───────────────────────────────────────────────────────────

export const runConflictCheck = async (
  leadId: string,
  organizationId: string,
  checkedById?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const normalizedEmail = lead.email.trim().toLowerCase();
  const normalizedName = normalizeName(lead.name);
  const matches: Array<{
    type: string;
    matchedId: string;
    matchedName: string;
    confidence: string;
    rule: string;
    details: string;
  }> = [];

  // ABA 1.7 — exact email match against active client contacts
  const emailMatches = await db
    .select({
      id: clientContacts.id,
      name: leads.name,
      clientId: clientContacts.clientId,
      email: clientContacts.email,
    })
    .from(clientContacts)
    .leftJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(
      and(
        eq(clientContacts.organizationId, organizationId),
        eq(clientContacts.email, normalizedEmail),
        eq(clients.status, "active"),
      ),
    );

  for (const m of emailMatches) {
    matches.push({
      type: "current_client",
      matchedId: m.clientId ?? m.id,
      matchedName: m.name ?? normalizedEmail,
      confidence: "exact_email",
      rule: "ABA_1.7",
      details: `Email ${normalizedEmail} matches active client contact`,
    });
  }

  // ABA 1.7 — name match against active client contacts
  const [firstName, ...rest] = normalizedName.split(" ");
  const lastName = rest.join(" ");
  if (firstName && lastName) {
    const nameMatches = await db
      .select({
        id: clientContacts.id,
        firstName: clientContacts.firstName,
        lastName: clientContacts.lastName,
        clientId: clientContacts.clientId,
      })
      .from(clientContacts)
      .leftJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(
        and(
          eq(clientContacts.organizationId, organizationId),
          eq(clients.status, "active"),
        ),
      );

    for (const m of nameMatches) {
      const contactName = `${m.firstName} ${m.lastName}`.toLowerCase();
      if (contactName === normalizedName && !matches.find((x) => x.matchedId === (m.clientId ?? m.id))) {
        matches.push({
          type: "current_client",
          matchedId: m.clientId ?? m.id,
          matchedName: `${m.firstName} ${m.lastName}`,
          confidence: "exact_name",
          rule: "ABA_1.7",
          details: `Name "${normalizedName}" matches active client`,
        });
      }
    }
  }

  // ABA 1.7 — adverse party match
  const adverseMatches = await db
    .select()
    .from(adverseParties)
    .where(
      and(
        eq(adverseParties.organizationId, organizationId),
        ilike(adverseParties.name, `%${normalizedName}%`),
      ),
    );

  for (const m of adverseMatches) {
    matches.push({
      type: "adverse_party",
      matchedId: m.id,
      matchedName: m.name,
      confidence: normalizeName(m.name) === normalizedName ? "exact_name" : "fuzzy_name",
      rule: "ABA_1.7",
      details: `Name matches adverse party on case ${m.caseId}`,
    });
  }

  // ABA 1.9 — former client contact match
  const formerMatches = await db
    .select({
      id: clientContacts.id,
      firstName: clientContacts.firstName,
      lastName: clientContacts.lastName,
      clientId: clientContacts.clientId,
      email: clientContacts.email,
    })
    .from(clientContacts)
    .leftJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(
      and(
        eq(clientContacts.organizationId, organizationId),
        eq(clients.status, "inactive"),
      ),
    );

  for (const m of formerMatches) {
    const contactName = `${m.firstName} ${m.lastName}`.toLowerCase();
    const emailMatch = m.email.toLowerCase() === normalizedEmail;
    const nameMatch = contactName === normalizedName;

    if ((emailMatch || nameMatch) && !matches.find((x) => x.matchedId === (m.clientId ?? m.id))) {
      matches.push({
        type: "former_client",
        matchedId: m.clientId ?? m.id,
        matchedName: `${m.firstName} ${m.lastName}`,
        confidence: emailMatch ? "exact_email" : "exact_name",
        rule: "ABA_1.9",
        details: `Matches former (inactive) client`,
      });
    }
  }

  // Determine overall status
  const hasConflict = matches.some(
    (m) => m.rule === "ABA_1.7" && m.confidence !== "fuzzy_name",
  );
  const hasReview = matches.some(
    (m) => m.rule === "ABA_1.9" || m.confidence === "fuzzy_name",
  );

  const status: "pass" | "needs_review" | "conflict_found" = hasConflict
    ? "conflict_found"
    : hasReview
      ? "needs_review"
      : "pass";

  const now = new Date();

  // Upsert conflict check (one per lead)
  let checkRecord;
  if (lead.conflictCheckId) {
    const [updated] = await db
      .update(conflictChecks)
      .set({ status, matches, checkedById, checkedAt: now, updatedAt: now })
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .returning();
    checkRecord = updated;
  } else {
    const [created] = await db
      .insert(conflictChecks)
      .values({ organizationId, leadId, status, matches, checkedById, checkedAt: now })
      .returning();
    checkRecord = created;

    await db
      .update(leads)
      .set({ conflictCheckId: created.id, updatedAt: now })
      .where(eq(leads.id, leadId));
  }

  // Auto-advance to questionnaire stage if pass
  if (status === "pass") {
    await db
      .update(leads)
      .set({ pipelineStage: "questionnaire", updatedAt: now })
      .where(eq(leads.id, leadId));
  } else if (status === "needs_review") {
    await db
      .update(leads)
      .set({ pipelineStage: "conflict_check", updatedAt: now })
      .where(eq(leads.id, leadId));
  }

  return checkRecord;
};

export const getConflictCheck = async (leadId: string, organizationId: string) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.conflictCheckId) return null;

  const [cc] = await db
    .select()
    .from(conflictChecks)
    .where(eq(conflictChecks.id, lead.conflictCheckId))
    .limit(1);

  return cc ?? null;
};

export const resolveConflictCheck = async (
  leadId: string,
  organizationId: string,
  staffId: string,
  data: {
    action: "manual_review" | "supervisor_override";
    status?: "pass" | "needs_review";
    reviewNotes?: string;
    supervisorNotes?: string;
  },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead || !lead.conflictCheckId) throw new NotFoundError("No conflict check found for this lead");

  const now = new Date();

  if (data.action === "supervisor_override") {
    const [updated] = await db
      .update(conflictChecks)
      .set({
        supervisorOverrideById: staffId,
        supervisorOverrideAt: now,
        supervisorOverrideNotes: data.supervisorNotes,
        updatedAt: now,
      })
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .returning();
    return updated;
  }

  // manual_review
  if (!data.status) throw new BadRequestError("status is required for manual_review action");
  const [updated] = await db
    .update(conflictChecks)
    .set({
      status: data.status,
      reviewedById: staffId,
      reviewedAt: now,
      reviewNotes: data.reviewNotes,
      updatedAt: now,
    })
    .where(eq(conflictChecks.id, lead.conflictCheckId))
    .returning();

  // If manually passed, advance stage
  if (data.status === "pass") {
    await db
      .update(leads)
      .set({ pipelineStage: "questionnaire", updatedAt: now })
      .where(eq(leads.id, leadId));
  }

  return updated;
};

// ─── Questionnaire ────────────────────────────────────────────────────────────

export const sendQuestionnaire = async (
  leadId: string,
  organizationId: string,
  sentById?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.caseTypeId) throw new BadRequestError("Lead must have a case type assigned before sending a questionnaire");

  const [systemQ] = await db
    .select()
    .from(caseTypeQuestionnaires)
    .where(eq(caseTypeQuestionnaires.caseTypeId, lead.caseTypeId))
    .limit(1);

  if (!systemQ) {
    throw new NotFoundError("No system questionnaire found for this case type. Contact a platform administrator.");
  }

  const schemaSnapshot = await buildSchemaSnapshot(organizationId, systemQ.id);
  if (!schemaSnapshot) throw new NotFoundError("Could not build questionnaire snapshot");

  const accessToken = generateAccessToken();
  const [send] = await db
    .insert(questionnaireSends)
    .values({
      organizationId,
      caseTypeQuestionnaireId: systemQ.id,
      leadId,
      caseTypeId: lead.caseTypeId,
      sentById,
      accessTokenHash: tokenHash(accessToken),
      schemaSnapshot: schemaSnapshot as any,
    })
    .returning();

  const now = new Date();
  await db
    .update(leads)
    .set({ questionnaireSendId: send.id, pipelineStage: "questionnaire", updatedAt: now })
    .where(eq(leads.id, leadId));

  const baseUrl = process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const clientLink = `${baseUrl}/questionnaire/${accessToken}`;

  // Fire-and-forget email to lead
  emailService
    .sendEmail({
      to: lead.email,
      subject: "Please complete your intake questionnaire",
      html: `<p>Dear ${lead.name},</p>
        <p>Please complete your intake questionnaire using the link below:</p>
        <p><a href="${clientLink}">Complete Questionnaire</a></p>
        <p>This link is unique to you. Please do not share it.</p>`,
    })
    .catch(console.error);

  return { send: { ...send, accessToken }, clientLink, sentAt: send.sentAt };
};

export const getLeadQuestionnaire = async (leadId: string, organizationId: string) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.questionnaireSendId) return null;

  const [send] = await db
    .select()
    .from(questionnaireSends)
    .where(eq(questionnaireSends.id, lead.questionnaireSendId))
    .limit(1);

  if (!send) return null;

  const [response] = await db
    .select()
    .from(questionnaireResponses)
    .where(eq(questionnaireResponses.questionnaireSendId, send.id))
    .limit(1);

  return { send, response: response ?? null };
};

// ─── Consultation ──────────────────────────────────────────────────────────────

export const createConsultation = async (
  leadId: string,
  organizationId: string,
  data: {
    scheduledAt: Date;
    duration: number;
    mode: "video" | "in_person";
    leadAttorneyId?: string;
    videoLink?: string;
    preConsultationNotes?: string;
  },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.consultationId) throw new ConflictError("Consultation already exists for this lead");

  const [consultation] = await db
    .insert(consultations)
    .values({
      organizationId,
      leadId,
      scheduledAt: data.scheduledAt,
      duration: data.duration,
      mode: data.mode,
      leadAttorneyId: data.leadAttorneyId,
      videoLink: data.videoLink,
      preConsultationNotes: data.preConsultationNotes,
    })
    .returning();

  const now = new Date();
  await db
    .update(leads)
    .set({ consultationId: consultation.id, pipelineStage: "consultation", updatedAt: now })
    .where(eq(leads.id, leadId));

  // Notify attorney and lead
  const scheduledStr = data.scheduledAt.toLocaleString("en-US", { timeZone: "UTC" });

  if (data.leadAttorneyId) {
    const [attorney] = await db
      .select({ email: staff.email, firstName: staff.firstName })
      .from(staff)
      .where(eq(staff.id, data.leadAttorneyId))
      .limit(1);

    if (attorney) {
      emailService
        .sendEmail({
          to: attorney.email,
          subject: `New consultation assigned: ${lead.name}`,
          html: `<p>Hi ${attorney.firstName},</p>
            <p>A consultation has been scheduled with <strong>${lead.name}</strong>.</p>
            <p><strong>Date/Time:</strong> ${scheduledStr} UTC</p>
            <p><strong>Mode:</strong> ${data.mode === "video" ? "Video Call" : "In Person"}</p>
            ${data.videoLink ? `<p><strong>Video Link:</strong> <a href="${data.videoLink}">${data.videoLink}</a></p>` : ""}
            ${data.preConsultationNotes ? `<p><strong>Pre-consultation notes:</strong> ${data.preConsultationNotes}</p>` : ""}`,
        })
        .catch(console.error);
    }
  }

  emailService
    .sendEmail({
      to: lead.email,
      subject: "Your consultation has been scheduled",
      html: `<p>Dear ${lead.name},</p>
        <p>Your consultation has been scheduled for <strong>${scheduledStr} UTC</strong>.</p>
        <p><strong>Mode:</strong> ${data.mode === "video" ? "Video Call" : "In Person"}</p>
        ${data.videoLink ? `<p><strong>Video Link:</strong> <a href="${data.videoLink}">${data.videoLink}</a></p>` : ""}
        <p>We look forward to speaking with you.</p>`,
    })
    .catch(console.error);

  return consultation;
};

export const getConsultation = async (leadId: string, organizationId: string) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.consultationId) return null;

  const [consultation] = await db
    .select()
    .from(consultations)
    .where(eq(consultations.id, lead.consultationId))
    .limit(1);

  return consultation ?? null;
};

export const updateConsultation = async (
  leadId: string,
  organizationId: string,
  data: Partial<{
    scheduledAt: Date;
    duration: number;
    mode: "video" | "in_person";
    videoLink: string;
    status: "scheduled" | "in_progress" | "completed" | "cancelled" | "no_show";
    preConsultationNotes: string;
    attorneyNotes: string;
    outcome: "proceed" | "close_no_case" | "refer_elsewhere" | "follow_up";
  }>,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead || !lead.consultationId) throw new NotFoundError("No consultation found for this lead");

  const [updated] = await db
    .update(consultations)
    .set({ ...data, mode: data.mode as any, status: data.status as any, outcome: data.outcome as any, updatedAt: new Date() })
    .where(eq(consultations.id, lead.consultationId))
    .returning();

  return updated;
};

// ─── Fee Agreement ─────────────────────────────────────────────────────────────

export const generateFeeAgreement = async (
  leadId: string,
  organizationId: string,
  data: { agreementType?: string; generatedFrom?: "questionnaire_auto" | "manual" },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.feeAgreementId) throw new ConflictError("Fee agreement already exists for this lead");

  const documentContent = `Fee Agreement for ${lead.name} — ${data.agreementType ?? "Standard Retainer"}`;
  const { envelopeId, signingLink } = await stubESignatureProvider.createEnvelope(
    lead.email,
    documentContent,
  );

  const [agreement] = await db
    .insert(feeAgreements)
    .values({
      organizationId,
      leadId,
      practiceAreaId: lead.practiceAreaId ?? undefined,
      caseTypeId: lead.caseTypeId ?? undefined,
      agreementType: data.agreementType,
      generatedFrom: (data.generatedFrom ?? "questionnaire_auto") as any,
      status: "pending_signature",
      envelopeId,
      signingLink,
    })
    .returning();

  const now = new Date();
  await db
    .update(leads)
    .set({ feeAgreementId: agreement.id, pipelineStage: "fee_agreement", updatedAt: now })
    .where(eq(leads.id, leadId));

  // Email signing link to lead
  emailService
    .sendEmail({
      to: lead.email,
      subject: "Please sign your fee agreement",
      html: `<p>Dear ${lead.name},</p>
        <p>Your fee agreement is ready for signature. Please click the link below to review and sign:</p>
        <p><a href="${signingLink}">Sign Agreement</a></p>
        <p>Please complete this at your earliest convenience.</p>`,
    })
    .catch(console.error);

  return { ...agreement, clientSigningLink: signingLink };
};

export const getFeeAgreement = async (leadId: string, organizationId: string) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.feeAgreementId) return null;

  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(eq(feeAgreements.id, lead.feeAgreementId))
    .limit(1);

  return agreement ?? null;
};

export const nudgeClient = async (agreementId: string, organizationId: string) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(eq(feeAgreements.id, agreementId), eq(feeAgreements.organizationId, organizationId)),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status === "signed") throw new ConflictError("Agreement is already signed");

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, agreement.leadId))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  const now = new Date();
  await db
    .update(feeAgreements)
    .set({ nudgedAt: now, updatedAt: now })
    .where(eq(feeAgreements.id, agreementId));

  await emailService.sendEmail({
    to: lead.email,
    subject: "Reminder: Please sign your fee agreement",
    html: `<p>Dear ${lead.name},</p>
      <p>This is a friendly reminder to sign your fee agreement:</p>
      ${agreement.signingLink ? `<p><a href="${agreement.signingLink}">Sign Agreement</a></p>` : ""}
      <p>Please complete this as soon as possible to proceed with your case.</p>`,
  });

  return { reminderSentAt: now };
};

// ─── eSignature Webhook ────────────────────────────────────────────────────────

export const handleESignatureWebhook = async (data: {
  envelopeId: string;
  status: string;
  signedAt?: string;
  signedBy?: string;
}) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(eq(feeAgreements.envelopeId, data.envelopeId))
    .limit(1);

  if (!agreement) return { ignored: true, reason: "No agreement found for envelope" };

  // Idempotent: already processed
  if (agreement.status === "signed") return { ignored: true, reason: "Already signed" };

  if (data.status !== "completed") {
    return { ignored: true, reason: `Envelope status ${data.status} not actionable` };
  }

  const now = new Date();
  await db
    .update(feeAgreements)
    .set({
      status: "signed",
      clientSignedAt: data.signedAt ? new Date(data.signedAt) : now,
      updatedAt: now,
    })
    .where(eq(feeAgreements.id, agreement.id));

  // Auto-advance lead to case_opening
  await db
    .update(leads)
    .set({ pipelineStage: "case_opening", updatedAt: now })
    .where(eq(leads.id, agreement.leadId));

  return { processed: true, agreementId: agreement.id };
};

// ─── Case Opening ──────────────────────────────────────────────────────────────

export const openCase = async (
  leadId: string,
  organizationId: string,
  data: {
    assignedStaffId?: string;
    teamId?: string;
    notes?: string;
  },
  creatorAdminId?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.convertedCaseId) throw new ConflictError("This lead has already been converted to a case");

  // Validate prerequisites
  if (lead.conflictCheckId) {
    const [cc] = await db
      .select()
      .from(conflictChecks)
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .limit(1);

    if (cc && cc.status === "conflict_found" && !cc.supervisorOverrideById) {
      throw new ConflictError("Conflict check must be resolved before opening a case");
    }
  }

  if (lead.feeAgreementId) {
    const [fa] = await db
      .select()
      .from(feeAgreements)
      .where(eq(feeAgreements.id, lead.feeAgreementId))
      .limit(1);

    if (!fa || fa.status !== "signed") {
      throw new ConflictError("Fee agreement must be signed before opening a case");
    }
  }

  if (!lead.practiceAreaId || !lead.caseTypeId) {
    throw new BadRequestError("Lead must have a practice area and case type before opening a case");
  }

  return db.transaction(async (tx) => {
    // 1. Create client entity
    const [client] = await tx
      .insert(clients)
      .values({
        organizationId,
        entityType: lead.entityType as any,
        displayName: lead.name,
        status: "active",
      })
      .returning();

    // 2. Create primary contact from lead data
    const nameParts = lead.name.trim().split(" ");
    const firstName = nameParts[0] ?? lead.name;
    const lastName = nameParts.slice(1).join(" ") || firstName;

    await tx.insert(clientContacts).values({
      organizationId,
      clientId: client.id,
      role: "primary",
      isPrimary: true,
      firstName,
      lastName,
      email: lead.email,
      phone: lead.phone ?? undefined,
    });

    // 3. Generate case number and create case
    const [practiceArea] = await tx
      .select({ id: practiceAreas.id })
      .from(practiceAreas)
      .where(eq(practiceAreas.id, lead.practiceAreaId!))
      .limit(1);

    const [caseType] = await tx
      .select()
      .from(practiceAreaCaseTypes)
      .where(eq(practiceAreaCaseTypes.id, lead.caseTypeId!))
      .limit(1);

    if (!caseType) throw new NotFoundError("Case type not found");

    const caseNumber = await generateCaseNumber(
      organizationId,
      lead.practiceAreaId!,
      caseType.code,
    );

    const [newCase] = await tx
      .insert(cases)
      .values({
        organizationId,
        caseNumber,
        clientId: client.id,
        leadId,
        practiceAreaId: lead.practiceAreaId!,
        caseTypeId: lead.caseTypeId!,
        caseType: caseType.code as any,
        priority: "medium",
        assignmentType: "internal_team",
        teamId: data.teamId,
        assignedStaffId: data.assignedStaffId ?? lead.assignedStaffId ?? undefined,
        requiredCertifications: [],
        filingDate: new Date().toISOString().split("T")[0],
        description: lead.situationSummary ?? `Case for ${lead.name}`,
        notes: data.notes,
        createdByAdminId: creatorAdminId,
      })
      .returning();

    // 4. Instantiate workflow steps from template
    const [template] = await tx
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.caseTypeId, lead.caseTypeId!))
      .limit(1);

    let workflowSteps: any[] = [];
    if (template) {
      const templateSteps = await tx
        .select()
        .from(workflowTemplateSteps)
        .where(eq(workflowTemplateSteps.templateId, template.id));

      if (templateSteps.length > 0) {
        const caseOpenDate = new Date();
        const stepValues = templateSteps
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((step) => ({
            organizationId,
            caseId: newCase.id,
            templateStepId: step.id,
            title: step.title,
            description: step.description,
            orderIndex: step.orderIndex,
            dueDate: step.dueInDays
              ? new Date(caseOpenDate.getTime() + step.dueInDays * 86400000)
                  .toISOString()
                  .split("T")[0]
              : undefined,
          }));

        workflowSteps = await tx
          .insert(caseWorkflowSteps)
          .values(stepValues)
          .returning();
      }
    }

    // 5. Update lead with conversion data
    const now = new Date();
    await tx
      .update(leads)
      .set({
        convertedClientId: client.id,
        convertedCaseId: newCase.id,
        convertedAt: now,
        pipelineStage: "case_opening",
        status: "reviewed",
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));

    // 6. Link questionnaire responses to the new client and case
    if (lead.questionnaireSendId) {
      await tx
        .update(questionnaireSends)
        .set({ clientId: client.id, caseId: newCase.id, updatedAt: now })
        .where(eq(questionnaireSends.id, lead.questionnaireSendId));

      await tx
        .update(questionnaireResponses)
        .set({ clientId: client.id, caseId: newCase.id, updatedAt: now })
        .where(eq(questionnaireResponses.questionnaireSendId, lead.questionnaireSendId));
    }

    // 7. Notify
    const assignedStaffId = data.assignedStaffId ?? lead.assignedStaffId;
    if (assignedStaffId) {
      const [assignedStaff] = await tx
        .select({ email: staff.email, firstName: staff.firstName })
        .from(staff)
        .where(eq(staff.id, assignedStaffId))
        .limit(1);

      if (assignedStaff) {
        emailService
          .sendEmail({
            to: assignedStaff.email,
            subject: `New case opened: ${newCase.caseNumber}`,
            html: `<p>Hi ${assignedStaff.firstName},</p>
              <p>A new case has been opened for ${lead.name}.</p>
              <p><strong>Case Number:</strong> ${newCase.caseNumber}</p>
              <p><strong>Case Type:</strong> ${caseType.name}</p>`,
          })
          .catch(console.error);
      }
    }

    emailService
      .sendEmail({
        to: lead.email,
        subject: "Your case has been opened",
        html: `<p>Dear ${lead.name},</p>
          <p>We are pleased to inform you that your case has been formally opened.</p>
          <p><strong>Case Number:</strong> ${newCase.caseNumber}</p>
          <p>Your attorney will be in touch with you shortly.</p>`,
      })
      .catch(console.error);

    return {
      client,
      case: newCase,
      workflowSteps,
      status: "active",
    };
  });
};

// ─── Case Workflow Steps ──────────────────────────────────────────────────────

export const getCaseWorkflowSteps = async (caseId: string, organizationId: string) => {
  return db
    .select()
    .from(caseWorkflowSteps)
    .where(
      and(
        eq(caseWorkflowSteps.caseId, caseId),
        eq(caseWorkflowSteps.organizationId, organizationId),
      ),
    );
};

export const updateCaseWorkflowStep = async (
  caseId: string,
  stepId: string,
  organizationId: string,
  data: Partial<{
    status: "pending" | "in_progress" | "completed" | "skipped";
    completedById: string;
    notes: string;
    dueDate: string;
  }>,
) => {
  const set: any = { ...data, updatedAt: new Date() };
  if (data.status === "completed" && !set.completedAt) {
    set.completedAt = new Date();
  }

  const [updated] = await db
    .update(caseWorkflowSteps)
    .set(set)
    .where(
      and(
        eq(caseWorkflowSteps.id, stepId),
        eq(caseWorkflowSteps.caseId, caseId),
        eq(caseWorkflowSteps.organizationId, organizationId),
      ),
    )
    .returning();

  if (!updated) throw new NotFoundError("Workflow step not found");
  return updated;
};

// ─── Adverse Parties ──────────────────────────────────────────────────────────

export const getAdverseParties = async (caseId: string, organizationId: string) => {
  return db
    .select()
    .from(adverseParties)
    .where(
      and(eq(adverseParties.caseId, caseId), eq(adverseParties.organizationId, organizationId)),
    );
};

export const addAdverseParty = async (
  caseId: string,
  organizationId: string,
  data: {
    name: string;
    email?: string;
    entityType?: "individual" | "company";
    relationship: string;
    notes?: string;
  },
) => {
  const [created] = await db
    .insert(adverseParties)
    .values({
      organizationId,
      caseId,
      name: data.name,
      email: data.email,
      entityType: (data.entityType ?? "individual") as any,
      relationship: data.relationship as any,
      notes: data.notes,
    })
    .returning();

  return created;
};

export const updateAdverseParty = async (
  caseId: string,
  partyId: string,
  organizationId: string,
  data: Partial<{ name: string; email: string; entityType: string; relationship: string; notes: string }>,
) => {
  const [updated] = await db
    .update(adverseParties)
    .set({ ...data, entityType: data.entityType as any, relationship: data.relationship as any, updatedAt: new Date() })
    .where(
      and(
        eq(adverseParties.id, partyId),
        eq(adverseParties.caseId, caseId),
        eq(adverseParties.organizationId, organizationId),
      ),
    )
    .returning();

  if (!updated) throw new NotFoundError("Adverse party not found");
  return updated;
};

export const deleteAdverseParty = async (
  caseId: string,
  partyId: string,
  organizationId: string,
) => {
  await db
    .delete(adverseParties)
    .where(
      and(
        eq(adverseParties.id, partyId),
        eq(adverseParties.caseId, caseId),
        eq(adverseParties.organizationId, organizationId),
      ),
    );
};

export class LeadsService {
  createLead = createLead;
  getAllLeads = getAllLeads;
  getLeadById = getLeadById;
  updateLead = updateLead;
  archiveLead = archiveLead;
  advanceLeadStage = advanceLeadStage;
  runConflictCheck = runConflictCheck;
  getConflictCheck = getConflictCheck;
  resolveConflictCheck = resolveConflictCheck;
  sendQuestionnaire = sendQuestionnaire;
  getLeadQuestionnaire = getLeadQuestionnaire;
  createConsultation = createConsultation;
  getConsultation = getConsultation;
  updateConsultation = updateConsultation;
  generateFeeAgreement = generateFeeAgreement;
  getFeeAgreement = getFeeAgreement;
  nudgeClient = nudgeClient;
  handleESignatureWebhook = handleESignatureWebhook;
  openCase = openCase;
  getCaseWorkflowSteps = getCaseWorkflowSteps;
  updateCaseWorkflowStep = updateCaseWorkflowStep;
  getAdverseParties = getAdverseParties;
  addAdverseParty = addAdverseParty;
  updateAdverseParty = updateAdverseParty;
  deleteAdverseParty = deleteAdverseParty;
}
