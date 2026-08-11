import { createHash, randomBytes, randomUUID } from "crypto";
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
import { adverseParties } from "../../db/schema/adverse-parties";
import {
  organization,
  team,
  teamMember,
  user,
} from "../../db/schema/auth-schema";
import { cases } from "../../db/schema/cases";
import { clientContacts } from "../../db/schema/client-contacts";
import { clients } from "../../db/schema/clients";
import { conflictChecks } from "../../db/schema/conflict-checks";
import { invoices } from "../../db/schema/invoices";
import {
  consultationFee,
  raiseConsultationInvoice,
} from "../finance/consultation-billing.service";
import { consultationLocations } from "../../db/schema/consultation-locations";
import { consultationSettings } from "../../db/schema/consultation-settings";
import {
  consultationParticipants,
  consultations,
} from "../../db/schema/consultations";
import { scenarioDocumentRequirements } from "../../db/schema/document-requirements";
import {
  feeAgreements,
  type FeeAgreementDetails,
} from "../../db/schema/fee-agreements";
import { leadTasks } from "../../db/schema/lead-tasks";
import { leadTimelineEvents } from "../../db/schema/lead-timeline-events";
import { leadEvents, leads } from "../../db/schema/leads";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  caseTypeQuestionnaireLogicRules,
  caseTypeQuestionnaireQuestions,
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  firmQuestionnaireLogicRules,
  firmQuestionnaireQuestions,
  firmQuestionnaireSections,
  questionnaireResponses,
  questionnaireSends,
} from "../../db/schema/questionnaires";
import { staff } from "../../db/schema/staff";
import { calendarEvents } from "../../db/schema/calendar-events";
import { teamPracticeAreaCaseTypes } from "../../db/schema/team-practice-area-case-types";
import { caseWorkflowSteps } from "../../db/schema/workflow";
import {
  cancelQuestionnaireReminder,
  scheduleQuestionnaireReminder,
} from "../../queue/queues";
import { formatDualZone, formatWithZone, nextAsapSlot } from "../../utils/date";
import { emailService } from "../../utils/email/email.service";
import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import { googleMeetService } from "../../utils/google-meet/google-meet.service";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { storageService } from "../../utils/storage/storage.service";
import { generateCaseNumber } from "../cases/cases.service";
import { materializeCaseTypeRequirements } from "../document-requirements/document-requirements.service";
import { relinkLeadDocumentsToCase } from "../documents/document-ingest";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import { hydrateCaseWorkflow } from "../workflow/workflow.service";
import { generateConsultationSlots } from "./consultation-slots.service";
import { getESignatureProvider } from "./dropbox-sign.provider";
import { assembleFeeAgreementDocument } from "./fee-agreement-document";
import { renderFeeAgreementPdf } from "./fee-agreement-pdf";
import { getLeadActivity, logLeadEvent } from "./lead-events.service";
import { getLeadMetrics } from "./lead-metrics.service";
import {
  addLeadNote,
  bulkDeleteNotes,
  bulkPinNotes,
  deleteLeadNote,
  getLeadNotes,
  toggleNotePin,
  updateLeadNote,
} from "./lead-notes.service";
import { LeadWorkflowService } from "./lead-workflow.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const generateAccessToken = () => randomBytes(32).toString("base64url");

const normalizeName = (name: string) => name.trim().toLowerCase();

// Entity/stopwords that should never constitute a match on their own, so an
// opponent like "Bianchi" matches the client "Bianchi Family Trust" without
// every "Group" or "Trust" colliding with one another.
const ENTITY_STOPWORDS = new Set([
  "family",
  "trust",
  "estate",
  "llc",
  "l.l.c",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "group",
  "holdings",
  "ltd",
  "limited",
  "lp",
  "llp",
  "plc",
  "pllc",
  "the",
  "and",
  "of",
  "&",
]);

const significantTokens = (name: string): string[] =>
  normalizeName(name)
    .split(/[\s,.]+/)
    .filter((t) => t.length > 0 && !ENTITY_STOPWORDS.has(t));

/**
 * Compares two names for conflict-check purposes.
 * - "exact"   — identical once normalized (trim + lowercase)
 * - "partial" — they share at least one significant (non-stopword) token
 * - null      — no meaningful overlap
 */
export const compareNames = (
  a: string | null | undefined,
  b: string | null | undefined,
): "exact" | "partial" | null => {
  if (!a || !b) return null;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return null;
  if (na === nb) return "exact";

  const tokensB = new Set(significantTokens(b));
  if (tokensB.size === 0) return null;
  const shares = significantTokens(a).some((t) => tokensB.has(t));
  return shares ? "partial" : null;
};

type StoredMatch = {
  type: string;
  matchedId: string;
  matchedName: string;
  confidence: string;
  rule: string;
  details: string;
  caseIds: string[];
};

const enrichMatchesWithCaseContext = async (
  storedMatches: StoredMatch[],
  organizationId: string,
) => {
  if (storedMatches.length === 0) return [];

  const allCaseIds = [...new Set(storedMatches.flatMap((m) => m.caseIds))];
  const adverseMatchIds = storedMatches
    .filter((m) => m.type === "adverse_party")
    .map((m) => m.matchedId);

  type CaseDetail = {
    id: string;
    caseNumber: string;
    caseType: string;
    status: string;
    practiceArea: string | null;
    clientId: string;
    clientName: string | null;
  };
  const caseMap = new Map<string, CaseDetail>();

  if (allCaseIds.length > 0) {
    const caseRows = await db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        caseType: cases.caseTypeId,
        status: cases.status,
        practiceArea: practiceAreas.name,
        clientId: cases.clientId,
        clientName: clients.displayName,
      })
      .from(cases)
      .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(
        and(
          inArray(cases.id, allCaseIds),
          eq(cases.organizationId, organizationId),
        ),
      );

    for (const row of caseRows) caseMap.set(row.id, row);
  }

  type AdverseContext = { relationship: string; firmClientName: string | null };
  const adverseContextMap = new Map<string, AdverseContext>();

  if (adverseMatchIds.length > 0) {
    const apRows = await db
      .select({
        id: adverseParties.id,
        relationship: adverseParties.relationship,
        caseId: adverseParties.caseId,
      })
      .from(adverseParties)
      .where(
        and(
          inArray(adverseParties.id, adverseMatchIds),
          eq(adverseParties.organizationId, organizationId),
        ),
      );

    for (const ap of apRows) {
      adverseContextMap.set(ap.id, {
        relationship: ap.relationship,
        firmClientName: caseMap.get(ap.caseId)?.clientName ?? null,
      });
    }
  }

  return storedMatches.map((m) => {
    const caseDetails = m.caseIds
      .map((id) => caseMap.get(id))
      .filter((c): c is CaseDetail => c !== undefined)
      .map(({ id, caseNumber, caseType, status, practiceArea }) => ({
        id,
        caseNumber,
        caseType,
        status,
        practiceArea,
      }));

    if (m.type === "adverse_party") {
      const ctx = adverseContextMap.get(m.matchedId);
      return {
        ...m,
        caseDetails,
        adversePartyRelationship: ctx?.relationship ?? null,
        firmClientName: ctx?.firmClientName ?? null,
      };
    }

    return { ...m, caseDetails };
  });
};

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
    .where(
      eq(
        caseTypeQuestionnaireSections.questionnaireId,
        caseTypeQuestionnaireId,
      ),
    );

  const systemQuestions = await db
    .select()
    .from(caseTypeQuestionnaireQuestions)
    .where(
      eq(
        caseTypeQuestionnaireQuestions.questionnaireId,
        caseTypeQuestionnaireId,
      ),
    );

  const systemLogicRules = await db
    .select()
    .from(caseTypeQuestionnaireLogicRules)
    .where(
      eq(
        caseTypeQuestionnaireLogicRules.questionnaireId,
        caseTypeQuestionnaireId,
      ),
    );

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

const createLead = async (
  organizationId: string,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    entityType?: "individual" | "company";
    source: string;
    practiceAreaId?: string;
    caseTypeId?: string;
    situationSummary?: string;
    intakeAdversePartyName?: string;
    intakeAdversePartyEmail?: string;
    timezone?: string;
    language?: string;
  },
  creatorStaffId: string,
) => {
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      entityType: (data.entityType ?? "individual") as any,
      source: data.source as any,
      situationSummary: data.situationSummary,
      practiceAreaId: data.practiceAreaId ?? null,
      caseTypeId: data.caseTypeId ?? null,
      respondentId: creatorStaffId,
      intakeAdversePartyName: data.intakeAdversePartyName,
      intakeAdversePartyEmail: data.intakeAdversePartyEmail,
      language: data.language,
      timezone: data.timezone,
    })
    .returning();

  await logLeadEvent({
    organizationId,
    leadId: lead.id,
    type: "lead_received",
    actorId: creatorStaffId,
    metadata: { source: data.source },
  });

  // Auto-initialize the intake pipeline tasks so the pipeline tab is
  // immediately populated without requiring a manual init click.
  const wfSvc = new LeadWorkflowService();
  await wfSvc.initializePipelineSteps(lead.id, organizationId);

  return lead;
};

const getAllLeads = async (
  organizationId: string,
  filters: Partial<PaginationParams> & {
    stage?: string;
    status?: string;
    practiceAreaId?: string;
    source?: string;
    search?: string;
    converted?: boolean;
    all?: boolean;
  } = {},
) => {
  const conditions = [eq(leads.organizationId, organizationId)];

  if (filters.stage)
    conditions.push(eq(leads.pipelineStage, filters.stage as any));
  if (filters.status) {
    conditions.push(eq(leads.status, filters.status as any));
  } else {
    // Hide declined leads from default lists; still queryable via ?status=declined
    conditions.push(ne(leads.status, "declined"));
  }
  if (filters.source) conditions.push(eq(leads.source, filters.source as any));

  // Converted leads. Keyed on convertedAt, not status: openCase writes status
  // "reviewed" and never "converted", so filtering on the status enum would
  // always return nothing.
  if (filters.converted !== undefined) {
    conditions.push(
      filters.converted
        ? isNotNull(leads.convertedCaseId)
        : isNull(leads.convertedCaseId),
    );
  }

  if (filters.practiceAreaId) {
    conditions.push(eq(leads.practiceAreaId, filters.practiceAreaId));
  }

  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(leads.firstName, q),
        ilike(leads.lastName, q),
        ilike(leads.email, q),
        ilike(leads.phone, q),
        // Matching the columns separately means "Jane Doe" finds nothing, since
        // no single column holds the full name.
        ilike(sql`${leads.firstName} || ' ' || ${leads.lastName}`, q),
      )!,
    );
  }

  const where = and(...conditions);

  const attachConflictMatches = async (
    rows: (typeof leads.$inferSelect & { caseTypeName: string | null })[],
  ) => {
    const conflictCheckLeads = rows.filter(
      (r) => r.pipelineStage === "conflict_check" && r.conflictCheckId,
    );
    if (conflictCheckLeads.length === 0) return rows;

    const ccIds = conflictCheckLeads.map((r) => r.conflictCheckId!);
    const checks = await db
      .select({
        id: conflictChecks.id,
        matches: conflictChecks.matches,
        status: conflictChecks.status,
      })
      .from(conflictChecks)
      .where(inArray(conflictChecks.id, ccIds));

    const matchesById = new Map(
      checks.map((c) => [c.id, { matches: c.matches, status: c.status }]),
    );

    const enriched = await Promise.all(
      rows.map(async (r) => {
        if (r.pipelineStage !== "conflict_check" || !r.conflictCheckId)
          return r;
        const conflict = matchesById.get(r.conflictCheckId) as
          { matches: StoredMatch[]; status: string } | undefined;
        if (!conflict) return r;
        const { matches, status } = conflict;
        if (!matches || matches.length === 0)
          return { ...r, conflictCheckStatus: status };
        const conflictMatches = await enrichMatchesWithCaseContext(
          matches,
          organizationId,
        );
        return { ...r, conflictMatches, conflictCheckStatus: status };
      }),
    );

    return enriched;
  };

  // Practice area and case type are columns on `leads` again, so their names
  // come from a plain join rather than a correlated json_agg subquery.
  const nameExpr = sql<string>`${leads.firstName} || ' ' || ${leads.lastName}`;

  if (filters.all) {
    const rows = await db
      .select({
        ...getTableColumns(leads),
        name: nameExpr,
        practiceAreaName: practiceAreas.name,
        caseTypeName: practiceAreaCaseTypes.name,
      })
      .from(leads)
      .leftJoin(practiceAreas, eq(practiceAreas.id, leads.practiceAreaId))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, leads.caseTypeId),
      )
      .where(where)
      .orderBy(desc(leads.createdAt));
    return attachConflictMatches(rows);
  }

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 10;
  const offset = getPaginationOffset({ page, limit });

  const [countRow] = await db
    .select({ total: count() })
    .from(leads)
    .where(where);

  const rows = await db
    .select({
      ...getTableColumns(leads),
      name: nameExpr,
      practiceAreaName: practiceAreas.name,
      caseTypeName: practiceAreaCaseTypes.name,
    })
    .from(leads)
    .leftJoin(practiceAreas, eq(practiceAreas.id, leads.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, leads.caseTypeId),
    )
    .where(where)
    .orderBy(desc(leads.createdAt))
    .limit(limit)
    .offset(offset);

  const enrichedRows = await attachConflictMatches(rows);

  return buildPaginatedResponse(
    enrichedRows,
    {
      page,
      limit,
      total: Number(countRow?.total ?? 0),
    },
    "leads",
  );
};

const getLeadById = async (id: string, organizationId: string) => {
  const [lead] = await db
    .select({
      ...getTableColumns(leads),
      name: sql<string>`${leads.firstName} || ' ' || ${leads.lastName}`,
      practiceAreaName: practiceAreas.name,
      caseTypeName: practiceAreaCaseTypes.name,
    })
    .from(leads)
    .leftJoin(practiceAreas, eq(practiceAreas.id, leads.practiceAreaId))
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.id, leads.caseTypeId),
    )
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

  // Prior consultations for this lead (follow-ups / re-schedules / cancelled),
  // newest first. The current one (if any) lives on `consultation`; everything
  // else is history for the card. Null-safe: when the lead has no current
  // consultation (e.g. after a cancellation), every consultation is history.
  const consultationHistory = (
    await db
      .select()
      .from(consultations)
      .where(
        and(
          eq(consultations.leadId, id),
          eq(consultations.organizationId, organizationId),
        ),
      )
      .orderBy(desc(consultations.createdAt))
  ).filter((c) => c.id !== lead.consultationId);

  return {
    ...lead,
    conflictCheck,
    questionnaireSend,
    consultation,
    consultationHistory,
    feeAgreement,
  };
};

/** Columns on `leads` that a user may edit directly. */
const EDITABLE_LEAD_COLUMNS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "source",
  "situationSummary",
  "entityType",
  "intakeAdversePartyName",
  "intakeAdversePartyEmail",
  "language",
  "timezone",
] as const;

type EditableColumn = (typeof EDITABLE_LEAD_COLUMNS)[number];

const updateLead = async (
  id: string,
  organizationId: string,
  data: Partial<
    Record<EditableColumn, string> & {
      practiceAreaId: string;
      caseTypeId: string;
      notes: string;
      noteContext: string;
    }
  >,
  actorId?: string,
) => {
  const [existing] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!existing) throw new NotFoundError("Lead not found");

  // `leads` has no notes column, so a body carrying `notes` was accepted by the
  // validator and then silently dropped — the observations staff typed into the
  // consultation card before a consultation existed were never saved anywhere.
  // Route them to the notes trail, which is where a note actually belongs.
  if (data.notes?.trim()) {
    await addLeadNote(
      id,
      organizationId,
      {
        type: "general",
        content: data.notes.trim(),
        context: (data.noteContext as any) ?? "lead_update",
      },
      actorId,
    ).catch((err) => console.error("Failed to save lead note", err));
  }

  // Only real columns reach .set(). The previous version spread the whole body,
  // so keys with no matching column (practiceAreaId, caseTypeId, notes,
  // timezone) were accepted by the validator and then silently dropped.
  const patch: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const column of EDITABLE_LEAD_COLUMNS) {
    const next = data[column];
    if (next === undefined) continue;

    const prev = (existing as Record<string, unknown>)[column];
    if (prev === next) continue;

    patch[column] = next;
    changes[column] = { from: prev ?? null, to: next };
  }

  // Practice area and case type are plain columns, but the activity trail must
  // record their *names* — "Immigration → Family law" is legible where a pair of
  // uuids is not.
  const practiceAreaChange = await diffNamedRef({
    prevId: existing.practiceAreaId,
    nextId: data.practiceAreaId,
    nameTable: practiceAreas,
  });

  const caseTypeChange = await diffNamedRef({
    prevId: existing.caseTypeId,
    nextId: data.caseTypeId,
    nameTable: practiceAreaCaseTypes,
  });

  if (practiceAreaChange) {
    patch.practiceAreaId = data.practiceAreaId;
    changes.practiceArea = practiceAreaChange;
  }
  if (caseTypeChange) {
    patch.caseTypeId = data.caseTypeId;
    changes.caseType = caseTypeChange;
  }

  // Nothing actually differs — don't touch updatedAt or write a hollow event
  // claiming an edit happened.
  if (Object.keys(changes).length === 0) return existing;

  const updated = await withTransaction(db, async () => {
    await db
      .update(leads)
      .set({ ...patch, updatedAt: new Date() } as any)
      .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)));

    await logLeadEvent({
      organizationId,
      leadId: id,
      type: "lead_updated",
      actorId,
      // The changed fields with their before and after values, so the activity
      // trail can say what changed rather than only that something did.
      metadata: { changes },
    });

    const [row] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)));
    return row;
  });

  return updated;
};

/**
 * Diff a uuid reference and resolve both sides to display names for the activity
 * trail. Returns null when the caller supplied no value or nothing changed, so
 * an unrelated edit never records a spurious change.
 */
const diffNamedRef = async (args: {
  prevId: string | null;
  nextId?: string;
  nameTable: typeof practiceAreas | typeof practiceAreaCaseTypes;
}) => {
  if (!args.nextId) return null;
  if (args.prevId === args.nextId) return null;

  const ids = [args.prevId, args.nextId].filter((v): v is string => Boolean(v));
  const names = await db
    .select({ id: args.nameTable.id, name: args.nameTable.name })
    .from(args.nameTable as any)
    .where(inArray(args.nameTable.id, ids));

  const nameById = new Map(names.map((n) => [n.id, n.name]));

  return {
    from: args.prevId ? (nameById.get(args.prevId) ?? args.prevId) : null,
    to: nameById.get(args.nextId) ?? args.nextId,
  };
};

const updateLeadStatus = async (
  id: string,
  organizationId: string,
  status: "archived" | "reviewed" | "new",
  actorId?: string,
) => {
  const [updated] = await db
    .update(leads)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead not found");

  // Archival has its own endpoint (archiveLead) that records the actor and
  // reason; this path only reaches "archived" from legacy callers.
  await logLeadEvent({
    organizationId,
    leadId: id,
    type: status === "archived" ? "lead_archived" : "lead_updated",
    actorId,
    metadata: { status },
  });

  return updated;
};

/**
 * Archive a lead, recording who did it and why. Distinct from
 * `updateLeadStatus({ status: "archived" })`, which cannot express either.
 */
const archiveLead = async (
  id: string,
  organizationId: string,
  data: { reason?: string } = {},
  actorId?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.status === "archived")
    throw new ConflictError("Lead is already archived");
  if (lead.convertedCaseId)
    throw new ConflictError("A converted lead cannot be archived");

  const now = new Date();
  const [updated] = await db
    .update(leads)
    .set({
      status: "archived",
      archivedById: actorId ?? null,
      archivedAt: now,
      archiveReason: data.reason ?? null,
      updatedAt: now,
    })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  await logLeadEvent({
    organizationId,
    leadId: id,
    type: "lead_archived",
    actorId,
    metadata: { reason: data.reason ?? null, priorStatus: lead.status },
  });

  return updated;
};

/**
 * Restore an archived lead. `updateLeadStatus` cannot do this: its validator
 * only accepts archived | reviewed, so a lead could never be returned to "new".
 * The prior status is recovered from the archival event rather than guessed —
 * falling back to "new" only when the lead predates the activity trail.
 */
const restoreLead = async (
  id: string,
  organizationId: string,
  actorId?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.status !== "archived")
    throw new ConflictError("Only an archived lead can be restored");

  const [lastArchive] = await db
    .select({ metadata: leadEvents.metadata })
    .from(leadEvents)
    .where(
      and(
        eq(leadEvents.leadId, id),
        eq(leadEvents.type, "lead_archived"),
        eq(leadEvents.organizationId, organizationId),
      ),
    )
    .orderBy(desc(leadEvents.createdAt))
    .limit(1);

  const priorStatus = (lastArchive?.metadata as { priorStatus?: string } | null)
    ?.priorStatus;

  // Only restore to a status the lead could legitimately hold again. A lead
  // archived while declined stays declined — restoring it to "new" would erase
  // a conflict decision.
  const restoredStatus =
    priorStatus === "reviewed" || priorStatus === "overridden"
      ? (priorStatus as "reviewed" | "overridden")
      : "new";

  const now = new Date();
  const [updated] = await db
    .update(leads)
    .set({
      status: restoredStatus,
      archivedById: null,
      archivedAt: null,
      archiveReason: null,
      updatedAt: now,
    })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  await logLeadEvent({
    organizationId,
    leadId: id,
    type: "lead_restored",
    actorId,
    metadata: { restoredStatus },
  });

  return updated;
};

const getLeadStageCounts = async (organizationId: string) => {
  const rows = await db
    .select({ stage: leads.pipelineStage, total: count() })
    .from(leads)
    // Exclude declined leads so stage badges match the default lists
    .where(
      and(
        eq(leads.organizationId, organizationId),
        ne(leads.status, "declined"),
      ),
    )
    .groupBy(leads.pipelineStage);

  const result: Record<string, number> = {
    conflict_check: 0,
    questionnaire: 0,
    consultation: 0,
    fee_agreement: 0,
    case_opening: 0,
  };

  for (const row of rows) {
    result[row.stage] = Number(row.total);
  }

  return result;
};

// Stage transitions are validated here before updating
const STAGE_ORDER = [
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
] as const;

/**
 * Stage transitions are the source of truth for time-in-stage metrics, so every
 * write to leads.pipelineStage — including the implicit ones inside the conflict
 * check, questionnaire, consultation and case-opening flows — must emit one of
 * these. A missed call shows up as a gap in the funnel, not as an error.
 */
const logStageChange = async (data: {
  organizationId: string;
  leadId: string;
  from: string;
  to: string;
  actorId?: string | null;
}) => {
  if (data.from === data.to) return;

  await logLeadEvent({
    organizationId: data.organizationId,
    leadId: data.leadId,
    type: "stage_changed",
    actorId: data.actorId,
    metadata: { from: data.from, to: data.to },
  });
};

/**
 * Consultation notes live in mutable columns on the consultation
 * (preConsultationNotes / attorneyNotes), which means they can be overwritten
 * and carry no author. Mirror each new value into lead_notes so it also lands
 * in the permanent, attributed, append-only record the Notes tab reads.
 *
 * Written only when the text actually changed and is non-empty, so re-saving an
 * unchanged note doesn't spam the trail. Skipped when there is no staff actor,
 * because an unattributed note is worthless as a record.
 */
const mirrorConsultationNote = async (data: {
  leadId: string;
  organizationId: string;
  type: "pre_consultation" | "post_consultation";
  content?: string | null;
  previous?: string | null;
  actorId?: string;
}) => {
  const content = data.content?.trim();
  if (!content) return;
  if (content === data.previous?.trim()) return;
  if (!data.actorId) return;

  await addLeadNote(
    data.leadId,
    data.organizationId,
    { type: data.type, content, context: "consultation" },
    data.actorId,
  ).catch((err) => {
    // A note that fails to mirror must not roll back the consultation itself.
    console.error("Failed to mirror consultation note", err);
  });
};

const advanceLeadStage = async (
  id: string,
  organizationId: string,
  newStage: string,
  actorId?: string,
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
    // A declined lead is terminal and may not advance.
    if (lead.status === "declined") {
      throw new ConflictError(
        "This lead has been declined for a conflict and cannot advance",
      );
    }

    if (newStage === "questionnaire" && lead.conflictCheckId) {
      const [cc] = await db
        .select()
        .from(conflictChecks)
        .where(eq(conflictChecks.id, lead.conflictCheckId))
        .limit(1);

      // Conflict check must be cleared (passed or approved) before advancing.
      if (!cc || cc.status !== "pass") {
        throw new ConflictError(
          "Conflict check must be cleared before advancing to questionnaire",
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
          throw new ConflictError(
            "Fee agreement must be signed before opening a case",
          );
        }
        if (!feeAgreementPaymentSatisfied(fa.details)) {
          throw new ConflictError(
            "Payment must be received before opening a case",
          );
        }
      }
    }
  }

  const [updated] = await db
    .update(leads)
    .set({ pipelineStage: newStage as any, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  await logStageChange({
    organizationId,
    leadId: id,
    from: lead.pipelineStage,
    to: newStage,
    actorId,
  });

  return updated;
};

// ─── Conflict Check ───────────────────────────────────────────────────────────

const runConflictCheck = async (
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
  const normalizedName = normalizeName(`${lead.firstName} ${lead.lastName}`);
  const matches: Array<{
    type: string;
    matchedId: string;
    matchedName: string;
    confidence: string;
    rule: string;
    details: string;
    caseIds: string[];
  }> = [];

  // ABA 1.7 — exact email match against active client contacts
  const emailMatches = await db
    .select({
      id: clientContacts.id,
      name: clients.displayName,
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
      caseIds: [],
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
      if (
        contactName === normalizedName &&
        !matches.find((x) => x.matchedId === (m.clientId ?? m.id))
      ) {
        matches.push({
          type: "current_client",
          matchedId: m.clientId ?? m.id,
          matchedName: `${m.firstName} ${m.lastName}`,
          confidence: "exact_name",
          rule: "ABA_1.7",
          details: `Name "${normalizedName}" matches active client`,
          caseIds: [],
        });
      }
    }
  }

  // ABA 1.7 — adverse party match (by name or email)
  const adverseMatches = await db
    .select()
    .from(adverseParties)
    .where(
      and(
        eq(adverseParties.organizationId, organizationId),
        or(
          ilike(adverseParties.name, `%${normalizedName}%`),
          adverseParties.email !== null
            ? eq(adverseParties.email, normalizedEmail)
            : undefined,
        ),
      ),
    );

  for (const m of adverseMatches) {
    const nameNormalized = normalizeName(m.name);
    const emailHit =
      m.email !== null && m.email.toLowerCase() === normalizedEmail;
    matches.push({
      type: "adverse_party",
      matchedId: m.id,
      matchedName: m.name,
      confidence:
        nameNormalized === normalizedName
          ? "exact_name"
          : emailHit
            ? "exact_email"
            : "fuzzy_name",
      rule: "ABA_1.7",
      details: `Name matches adverse party on case ${m.caseId}`,
      caseIds: [m.caseId],
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

    if (
      (emailMatch || nameMatch) &&
      !matches.find((x) => x.matchedId === (m.clientId ?? m.id))
    ) {
      matches.push({
        type: "former_client",
        matchedId: m.clientId ?? m.id,
        matchedName: `${m.firstName} ${m.lastName}`,
        confidence: emailMatch ? "exact_email" : "exact_name",
        rule: "ABA_1.9",
        details: `Matches former (inactive) client`,
        caseIds: [],
      });
    }
  }

  // ABA 1.7 — shared surname (potential related party, e.g. divorce)
  const [, ...surnameParts] = normalizedName.split(" ");
  const normalizedLastName = surnameParts.join(" ");

  if (normalizedLastName.length >= 2) {
    const surnameMatches = await db
      .select({
        id: clientContacts.id,
        firstName: clientContacts.firstName,
        lastName: clientContacts.lastName,
        clientId: clientContacts.clientId,
        displayName: clients.displayName,
      })
      .from(clientContacts)
      .leftJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(
        and(
          eq(clientContacts.organizationId, organizationId),
          eq(clients.status, "active"),
          or(
            ilike(clientContacts.lastName, normalizedLastName),
            ilike(clients.displayName, `%${normalizedLastName}%`),
          ),
        ),
      );

    for (const m of surnameMatches) {
      const resolvedName = m.displayName ?? `${m.firstName} ${m.lastName}`;
      const resolvedNameNormalized = resolvedName.toLowerCase();
      if (
        resolvedNameNormalized === normalizedName ||
        matches.find((x) => x.matchedId === (m.clientId ?? m.id)) ||
        matches.find(
          (x) =>
            x.type === "related_party" &&
            x.matchedName.toLowerCase() === resolvedNameNormalized,
        )
      )
        continue;

      matches.push({
        type: "related_party",
        matchedId: m.clientId ?? m.id,
        matchedName: resolvedName,
        confidence: "surname_match",
        rule: "ABA_1.7",
        details: `Name contains "${normalizedLastName}" — matches active client ${resolvedName}`,
        caseIds: [],
      });
    }
  }

  // ABA 1.7 / 1.9 — intake adverse party: does the lead's proposed opponent match a current or former client?
  if (lead.intakeAdversePartyName || lead.intakeAdversePartyEmail) {
    // Opponent name matching is delegated to compareNames (token-based); only the
    // email needs explicit normalization here.
    const normalizedOpponentEmail = lead.intakeAdversePartyEmail
      ? lead.intakeAdversePartyEmail.trim().toLowerCase()
      : null;

    const activeOpponentContacts = await db
      .select({
        id: clientContacts.id,
        firstName: clientContacts.firstName,
        lastName: clientContacts.lastName,
        clientId: clientContacts.clientId,
        email: clientContacts.email,
        clientName: clients.displayName,
      })
      .from(clientContacts)
      .leftJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(
        and(
          eq(clientContacts.organizationId, organizationId),
          eq(clients.status, "active"),
        ),
      );

    for (const m of activeOpponentContacts) {
      const emailHit =
        !!normalizedOpponentEmail &&
        m.email?.toLowerCase() === normalizedOpponentEmail;
      const nameStrengths = [
        compareNames(
          lead.intakeAdversePartyName,
          `${m.firstName} ${m.lastName}`,
        ),
        compareNames(lead.intakeAdversePartyName, m.clientName),
      ];
      const strength = emailHit
        ? "exact"
        : nameStrengths.includes("exact")
          ? "exact"
          : nameStrengths.includes("partial")
            ? "partial"
            : null;

      if (
        strength &&
        !matches.find(
          (x) =>
            x.type === "client_is_opponent" &&
            x.matchedId === (m.clientId ?? m.id),
        )
      ) {
        matches.push({
          type: "client_is_opponent",
          matchedId: m.clientId ?? m.id,
          matchedName: m.clientName ?? `${m.firstName} ${m.lastName}`,
          // Partial matches (e.g. "Bianchi" vs "Bianchi Family Trust") route to
          // needs_review; exact matches remain a hard ABA 1.7 conflict.
          confidence:
            strength === "exact"
              ? emailHit
                ? "exact_email"
                : "exact_name"
              : "fuzzy_name",
          rule: "ABA_1.7",
          details: `Proposed opposing party "${lead.intakeAdversePartyName ?? lead.intakeAdversePartyEmail}" matches active client`,
          caseIds: [],
        });
      }
    }

    const inactiveOpponentContacts = await db
      .select({
        id: clientContacts.id,
        firstName: clientContacts.firstName,
        lastName: clientContacts.lastName,
        clientId: clientContacts.clientId,
        email: clientContacts.email,
        clientName: clients.displayName,
      })
      .from(clientContacts)
      .leftJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(
        and(
          eq(clientContacts.organizationId, organizationId),
          eq(clients.status, "inactive"),
        ),
      );

    for (const m of inactiveOpponentContacts) {
      const emailHit =
        !!normalizedOpponentEmail &&
        m.email?.toLowerCase() === normalizedOpponentEmail;
      const nameStrengths = [
        compareNames(
          lead.intakeAdversePartyName,
          `${m.firstName} ${m.lastName}`,
        ),
        compareNames(lead.intakeAdversePartyName, m.clientName),
      ];
      const strength = emailHit
        ? "exact"
        : nameStrengths.includes("exact")
          ? "exact"
          : nameStrengths.includes("partial")
            ? "partial"
            : null;

      if (
        strength &&
        !matches.find(
          (x) =>
            x.type === "former_client_is_opponent" &&
            x.matchedId === (m.clientId ?? m.id),
        )
      ) {
        matches.push({
          type: "former_client_is_opponent",
          matchedId: m.clientId ?? m.id,
          matchedName: m.clientName ?? `${m.firstName} ${m.lastName}`,
          // ABA 1.9 matches are always needs_review; confidence still reflects
          // whether the opponent name matched exactly or partially.
          confidence:
            strength === "exact"
              ? emailHit
                ? "exact_email"
                : "exact_name"
              : "fuzzy_name",
          rule: "ABA_1.9",
          details: `Proposed opposing party "${lead.intakeAdversePartyName ?? lead.intakeAdversePartyEmail}" matches former (inactive) client`,
          caseIds: [],
        });
      }
    }
  }

  // Populate caseIds for client-based matches
  const clientMatchIds = [
    ...new Set(
      matches.filter((m) => m.type !== "adverse_party").map((m) => m.matchedId),
    ),
  ];
  if (clientMatchIds.length > 0) {
    const relatedCases = await db
      .select({ id: cases.id, clientId: cases.clientId })
      .from(cases)
      .where(
        and(
          eq(cases.organizationId, organizationId),
          inArray(cases.clientId, clientMatchIds),
        ),
      );
    const casesByClientId = new Map<string, string[]>();
    for (const c of relatedCases) {
      const arr = casesByClientId.get(c.clientId) ?? [];
      arr.push(c.id);
      casesByClientId.set(c.clientId, arr);
    }
    for (const match of matches) {
      if (match.type !== "adverse_party") {
        match.caseIds = casesByClientId.get(match.matchedId) ?? [];
      }
    }
  }

  // Determine overall status
  const hasConflict = matches.some(
    (m) =>
      m.rule === "ABA_1.7" &&
      (m.confidence === "exact_email" || m.confidence === "exact_name"),
  );
  const hasReview = matches.some(
    (m) =>
      m.rule === "ABA_1.9" ||
      m.confidence === "fuzzy_name" ||
      m.confidence === "surname_match",
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
      .set({
        status,
        matches,
        checkedById,
        checkedAt: now,
        updatedAt: now,
        // Re-running a check invalidates any prior resolution so a stale
        // approval can't silently clear a freshly-surfaced conflict.
        reviewedById: null,
        reviewedAt: null,
        reviewNotes: null,
        supervisorOverrideById: null,
        supervisorOverrideAt: null,
        supervisorOverrideNotes: null,
      })
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .returning();
    checkRecord = updated;
  } else {
    const [created] = await db
      .insert(conflictChecks)
      .values({
        organizationId,
        leadId,
        status,
        matches,
        checkedById,
        checkedAt: now,
      })
      .returning();
    checkRecord = created;

    await db
      .update(leads)
      .set({ conflictCheckId: created.id, updatedAt: now })
      .where(
        and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
      );
  }

  await logLeadEvent({
    organizationId,
    leadId,
    type: "conflict_check_run",
    actorId: checkedById,
    metadata: { status, matchCount: matches.length },
  });

  // Auto-advance the pipeline stage based on the result, but never regress a
  // lead that is already further along and never touch a terminal lead.
  if (lead.status !== "declined") {
    const currentIdx = STAGE_ORDER.indexOf(lead.pipelineStage as any);
    if (status === "pass") {
      // Clear leads move on to the questionnaire (only from conflict_check or earlier).
      if (currentIdx < STAGE_ORDER.indexOf("questionnaire")) {
        await db
          .update(leads)
          .set({ pipelineStage: "questionnaire", updatedAt: now })
          .where(
            and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
          );

        await logStageChange({
          organizationId,
          leadId,
          from: lead.pipelineStage,
          to: "questionnaire",
          actorId: checkedById,
        });
      }
    } else {
      // needs_review / conflict_found are held at conflict_check.
      if (currentIdx < STAGE_ORDER.indexOf("conflict_check")) {
        await db
          .update(leads)
          .set({ pipelineStage: "conflict_check", updatedAt: now })
          .where(
            and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
          );

        await logStageChange({
          organizationId,
          leadId,
          from: lead.pipelineStage,
          to: "conflict_check",
          actorId: checkedById,
        });
      }
    }
  }

  const enrichedMatches = await enrichMatchesWithCaseContext(
    matches,
    organizationId,
  );
  return { ...checkRecord, matches: enrichedMatches };
};

const getLeadLayout = async (leadId: string, organizationId: string) => {
  const [lead] = await db
    .select({
      id: leads.id,
      name: sql<string>`concat(${leads.firstName}, ' ', ${leads.lastName})`,
      pipelineStage: leads.pipelineStage,
      receivedAt: leads.createdAt,
      situationSummary: leads.situationSummary,
      intakeAdversePartyName: leads.intakeAdversePartyName,
      intakeAdversePartyEmail: leads.intakeAdversePartyEmail,
      convertedCaseId: leads.convertedCaseId,
    })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  return lead;
};

const getConflictCheck = async (leadId: string, organizationId: string) => {
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

  if (!cc) return null;

  const storedMatches = (cc.matches ?? []) as StoredMatch[];
  const enrichedMatches = await enrichMatchesWithCaseContext(
    storedMatches,
    organizationId,
  );
  return { ...cc, matches: enrichedMatches };
};

// Neutral, non-accusatory notice. NEVER discloses the conflict, matched party,
// or any specifics — see plan A7.
const buildDeclineEmail = (lead: { firstName: string; email: string }) => ({
  to: lead.email,
  subject: "Update on your inquiry",
  html: `
    <p>Dear ${lead.firstName},</p>
    <p>Thank you for reaching out to our firm. After careful review, we are
       unable to move forward with your matter at this time.</p>
    <p>We are not able to share the specific reason, and this decision does
       not reflect on the merits of your situation. We encourage you to seek
       other counsel promptly so any important deadlines are protected.</p>
    <p>We wish you the very best.</p>`,
});

const resolveConflictCheck = async (
  leadId: string,
  organizationId: string,
  staffId: string,
  data: {
    action: "approve" | "decline";
    reviewNotes: string;
  },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead || !lead.conflictCheckId)
    throw new NotFoundError("No conflict check found for this lead");

  if (!staffId) {
    throw new AuthorizationError(
      "A valid staff profile is required to resolve conflicts",
    );
  }
  const [staffRecord] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
    .limit(1);

  if (!staffRecord)
    throw new AuthorizationError(
      "A valid staff profile is required to resolve conflicts",
    );

  const [cc] = await db
    .select()
    .from(conflictChecks)
    .where(eq(conflictChecks.id, lead.conflictCheckId))
    .limit(1);

  if (!cc) throw new NotFoundError("No conflict check found for this lead");

  const wasHardConflict = cc.status === "conflict_found";
  const now = new Date();

  const updated = await withTransaction(db, async () => {
    if (data.action === "approve") {
      const [u] = await db
        .update(conflictChecks)
        .set({
          status: "pass",
          reviewedById: staffId,
          reviewedAt: now,
          reviewNotes: data.reviewNotes,
          updatedAt: now,
        })
        .where(eq(conflictChecks.id, cc.id))
        .returning();

      await db
        .update(leads)
        .set({
          status: wasHardConflict ? "overridden" : "reviewed",
          // Advance off conflict_check, but never regress a further-along lead
          pipelineStage:
            lead.pipelineStage === "conflict_check"
              ? "questionnaire"
              : lead.pipelineStage,
          updatedAt: now,
        })
        .where(eq(leads.id, leadId));

      // A hard conflict cleared by a reviewer is an override — the distinction
      // the trail has to preserve, since it is the accountable decision.
      await logLeadEvent({
        organizationId,
        leadId,
        type: wasHardConflict
          ? "conflict_overridden"
          : "conflict_check_approved",
        actorId: staffId,
        metadata: { reviewNotes: data.reviewNotes, priorStatus: cc.status },
      });

      if (lead.pipelineStage === "conflict_check") {
        await logStageChange({
          organizationId,
          leadId,
          from: lead.pipelineStage,
          to: "questionnaire",
          actorId: staffId,
        });
      }

      return u;
    }

    // decline — terminate the lead for conflict
    const [u] = await db
      .update(conflictChecks)
      .set({
        status: "conflict_found",
        reviewedById: staffId,
        reviewedAt: now,
        reviewNotes: data.reviewNotes,
        updatedAt: now,
      })
      .where(eq(conflictChecks.id, cc.id))
      .returning();

    await db
      .update(leads)
      .set({ status: "declined", updatedAt: now }) // stage left as-is (terminal)
      .where(eq(leads.id, leadId));

    await logLeadEvent({
      organizationId,
      leadId,
      type: "conflict_check_declined",
      actorId: staffId,
      metadata: { reviewNotes: data.reviewNotes },
    });

    return u;
  });

  // Notify the lead after the resolution has committed. Fire-and-forget so an
  // email failure can never roll back the decision.
  if (data.action === "decline")
    emailService.sendEmail(buildDeclineEmail(lead)).catch(console.error);

  const enrichedMatches = await enrichMatchesWithCaseContext(
    (updated.matches ?? []) as StoredMatch[],
    organizationId,
  );

  return { ...updated, matches: enrichedMatches };
};

// ─── Questionnaire ────────────────────────────────────────────────────────────

type CustomQuestionInput = {
  label: string;
  type?: string;
  isRequired?: boolean;
  saveToFirm?: boolean;
};

type CustomDocumentInput = {
  label: string;
  isRequired?: boolean;
  saveToFirm?: boolean;
};

export type SendQuestionnaireConfig = {
  deliveryChannels?: ("email" | "sms")[];
  language?: string;
  autoReminderDays?: number | null;
  customQuestions?: CustomQuestionInput[];
  customDocumentRequests?: CustomDocumentInput[];
};

/**
 * Get (or lazily create) the firm's "Additional questions" section for a case
 * type — the home for custom questions/docs the staff chose to persist.
 */
const getOrCreateFirmAdditionsSection = async (
  organizationId: string,
  caseTypeId: string,
) => {
  const existing = await db
    .select()
    .from(firmQuestionnaireSections)
    .where(
      and(
        eq(firmQuestionnaireSections.organizationId, organizationId),
        eq(firmQuestionnaireSections.caseTypeId, caseTypeId),
        eq(firmQuestionnaireSections.title, "Additional questions"),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const [{ value: maxOrder } = { value: 0 }] = await db
    .select({ value: count() })
    .from(firmQuestionnaireSections)
    .where(
      and(
        eq(firmQuestionnaireSections.organizationId, organizationId),
        eq(firmQuestionnaireSections.caseTypeId, caseTypeId),
      ),
    );

  const [section] = await db
    .insert(firmQuestionnaireSections)
    .values({
      organizationId,
      caseTypeId,
      title: "Additional questions",
      orderIndex: Number(maxOrder) + 100,
    })
    .returning();
  return section;
};

const sendQuestionnaire = async (
  leadId: string,
  organizationId: string,
  sentById?: string,
  config: SendQuestionnaireConfig = {},
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  // Resolve the case type from the junction table
  const [leadCaseType] = await db
    .select({ caseTypeId: leads.caseTypeId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  const caseTypeId = leadCaseType?.caseTypeId;
  if (!caseTypeId)
    throw new BadRequestError(
      "Lead must have a case type assigned before sending a questionnaire",
    );

  const [systemQ] = await db
    .select()
    .from(caseTypeQuestionnaires)
    .where(eq(caseTypeQuestionnaires.caseTypeId, caseTypeId))
    .limit(1);

  if (!systemQ) {
    throw new NotFoundError(
      "No system questionnaire found for this case type. Contact a platform administrator.",
    );
  }

  // Custom items the staff chose to persist become firm questions so every future
  // send for this case type includes them. They get attached to a firm section and
  // are then picked up automatically by buildSchemaSnapshot below.
  const persistQuestions = (config.customQuestions ?? []).filter(
    (q) => q.saveToFirm,
  );
  const persistDocs = (config.customDocumentRequests ?? []).filter(
    (d) => d.saveToFirm,
  );
  if (persistQuestions.length || persistDocs.length) {
    const section = await getOrCreateFirmAdditionsSection(
      organizationId,
      caseTypeId,
    );
    let order = Date.now() % 100000;
    for (const q of persistQuestions) {
      await db.insert(firmQuestionnaireQuestions).values({
        organizationId,
        caseTypeId,
        firmSectionId: section.id,
        label: q.label,
        type: (q.type ?? "short_text") as any,
        orderIndex: order++,
        isRequired: q.isRequired ?? false,
      });
    }
    for (const d of persistDocs) {
      await db.insert(firmQuestionnaireQuestions).values({
        organizationId,
        caseTypeId,
        firmSectionId: section.id,
        label: d.label,
        type: "file_upload" as any,
        orderIndex: order++,
        isRequired: d.isRequired ?? false,
      });
    }
  }

  const schemaSnapshot = await buildSchemaSnapshot(organizationId, systemQ.id);
  if (!schemaSnapshot)
    throw new NotFoundError("Could not build questionnaire snapshot");

  // Per-send-only custom items are appended directly to this send's snapshot with
  // synthetic ids (no DB row). The snapshot is the source of truth for rendering
  // and for matching answers, so unsaved questions still work end-to-end.
  const sendOnlyQuestions = (config.customQuestions ?? []).filter(
    (q) => !q.saveToFirm,
  );
  const sendOnlyDocs = (config.customDocumentRequests ?? []).filter(
    (d) => !d.saveToFirm,
  );
  const extraSections: any[] = [];
  if (sendOnlyQuestions.length) {
    extraSections.push({
      id: randomUUID(),
      source: "firm",
      title: "Additional questions",
      description: null,
      questions: sendOnlyQuestions.map((q, i) => ({
        id: randomUUID(),
        source: "firm",
        label: q.label,
        description: null,
        type: q.type ?? "short_text",
        orderIndex: i,
        isRequired: q.isRequired ?? false,
        config: {},
        isLocked: false,
      })),
    });
  }
  if (sendOnlyDocs.length) {
    extraSections.push({
      id: randomUUID(),
      source: "firm",
      title: "Requested documents",
      description: null,
      questions: sendOnlyDocs.map((d, i) => ({
        id: randomUUID(),
        source: "firm",
        label: d.label,
        description: null,
        type: "file_upload",
        orderIndex: i,
        isRequired: d.isRequired ?? false,
        config: {},
        isLocked: false,
      })),
    });
  }
  const finalSnapshot = {
    ...schemaSnapshot,
    sections: [...schemaSnapshot.sections, ...extraSections],
  };

  const deliveryChannels = config.deliveryChannels?.length
    ? config.deliveryChannels
    : ["email"];
  const language = config.language ?? "english";
  const autoReminderDays =
    config.autoReminderDays && config.autoReminderDays > 0
      ? config.autoReminderDays
      : null;

  const accessToken = generateAccessToken();
  const [send] = await db
    .insert(questionnaireSends)
    .values({
      organizationId,
      caseTypeQuestionnaireId: systemQ.id,
      leadId,
      caseTypeId,
      sentById,
      accessTokenHash: tokenHash(accessToken),
      schemaSnapshot: finalSnapshot as any,
      deliveryChannels,
      language,
      autoReminderDays,
    })
    .returning();

  // Snapshot every file_upload question as a document requirement.
  //
  // Materialized rather than derived at query time so that later edits to the
  // questionnaire template cannot retroactively rewrite what this matter was
  // asked for — the audit trail has to reflect what the client actually saw.
  const fileUploadQuestions = (finalSnapshot.sections ?? []).flatMap(
    (section: any) =>
      (section.questions ?? []).filter((q: any) => q.type === "file_upload"),
  );

  if (fileUploadQuestions.length) {
    await db
      .insert(scenarioDocumentRequirements)
      .values(
        fileUploadQuestions.map((q: any, index: number) => ({
          organizationId,
          leadId,
          label: q.label as string,
          isRequired: Boolean(q.isRequired),
          orderIndex: index,
          source: "questionnaire" as const,
          questionnaireQuestionId: q.id as string,
        })),
      )
      .onConflictDoNothing();
  }

  // Schedule the auto-reminder as a delayed job; remember its id so we can cancel
  // it when the response is submitted.
  if (autoReminderDays) {
    const reminderJobId = await scheduleQuestionnaireReminder(
      send.id,
      autoReminderDays,
    );
    if (reminderJobId) {
      await db
        .update(questionnaireSends)
        .set({ reminderJobId })
        .where(eq(questionnaireSends.id, send.id));
    }
  }

  const now = new Date();
  // Never move a lead backward: an instant-consultation lead is already at the
  // consultation stage when its questionnaire is auto-sent on completion.
  const currentStageIdx = STAGE_ORDER.indexOf(lead.pipelineStage as any);
  const advancesToQuestionnaire =
    currentStageIdx < STAGE_ORDER.indexOf("questionnaire");

  await db
    .update(leads)
    .set({
      questionnaireSendId: send.id,
      ...(advancesToQuestionnaire
        ? { pipelineStage: "questionnaire" as const }
        : {}),
      updatedAt: now,
    })
    .where(eq(leads.id, leadId));

  await logLeadEvent({
    organizationId,
    leadId,
    type: "questionnaire_sent",
    actorId: sentById,
    metadata: { sendId: send.id, deliveryChannels, language, autoReminderDays },
  });

  if (advancesToQuestionnaire) {
    await logStageChange({
      organizationId,
      leadId,
      from: lead.pipelineStage,
      to: "questionnaire",
      actorId: sentById,
    });
  }

  const baseUrl = env.FRONTEND_APP_URL ?? "http://localhost:5173";
  const orgSlug = encodeURIComponent(organizationId);
  const clientLink = `${baseUrl}/questionnaire/${orgSlug}/${accessToken}`;

  // Fire-and-forget delivery to lead via the configured channels.
  if (deliveryChannels.includes("email")) {
    emailService
      .sendEmail({
        to: lead.email,
        subject: "Please complete your intake questionnaire",
        html: `<p>Dear ${lead.firstName},</p>
          <p>Please complete your intake questionnaire using the link below:</p>
          <p><a href="${clientLink}">Complete Questionnaire</a></p>
          <p>This link is unique to you. Please do not share it.</p>`,
      })
      .catch(console.error);
  }
  if (deliveryChannels.includes("sms") && lead.phone) {
    // SMS provider not yet wired — log the intent for now.
    console.log(
      `[sms-stub] questionnaire link to ${lead.phone}: ${clientLink}`,
    );
  }

  return { send: { ...send, accessToken }, clientLink, sentAt: send.sentAt };
};

/** Cancel a send's pending auto-reminder, if any (e.g. on submission). */
export const cancelSendReminder = async (
  sendId: string,
  organizationId: string,
) => {
  const [send] = await db
    .select()
    .from(questionnaireSends)
    .where(
      and(
        eq(questionnaireSends.id, sendId),
        eq(questionnaireSends.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (send?.reminderJobId) {
    await cancelQuestionnaireReminder(send.reminderJobId).catch(console.error);
  }
};

const getLeadQuestionnaire = async (leadId: string, organizationId: string) => {
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

const initiateConsultation = async (
  leadId: string,
  organizationId: string,
  data: {
    leadAttorneyId: string;
    participantStaffIds?: string[];
    mode: "video" | "in_person" | "phone_call";
    duration: number;
    locationId?: string;
    feeAmount?: number;
    preConsultationNotes?: string;
    notifyChannels?: ("email" | "sms")[];
    urgent?: boolean;
    parentConsultationId?: string;
    startNow?: boolean;
    paymentTiming?: "pay_now" | "invoice_after" | "pay_in_person";
    isEmergency?: boolean;
    emergencyMultiplier?: number;
    autoSendQuestionnaire?: boolean;
  },
  scheduledById?: string,
) => {
  // Instant consultations ("start now") are urgent by definition: they skip
  // the slot queue and require a passed conflict check.
  const startNow = Boolean(data.startNow);
  const urgent = Boolean(data.urgent || startNow);

  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");

  // Block only when the lead already has an ACTIVE consultation. Cancelled,
  // completed, or no-show ones can be superseded by a new booking (re-schedule
  // after cancel) or a follow-up.
  if (lead.consultationId) {
    const [existing] = await db
      .select({ status: consultations.status })
      .from(consultations)
      .where(eq(consultations.id, lead.consultationId))
      .limit(1);
    const inactive = ["cancelled", "no_show", "completed"];
    if (existing && !inactive.includes(existing.status))
      throw new ConflictError(
        "An active consultation already exists for this lead",
      );
  }

  // Follow-up: the parent must be a completed consultation for this same lead.
  if (data.parentConsultationId) {
    const [parent] = await db
      .select({ leadId: consultations.leadId, status: consultations.status })
      .from(consultations)
      .where(
        and(
          eq(consultations.id, data.parentConsultationId),
          eq(consultations.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!parent || parent.leadId !== leadId)
      throw new BadRequestError("Parent consultation not found for this lead");
    if (parent.status !== "completed")
      throw new BadRequestError(
        "Follow-ups can only be scheduled after the prior consultation is completed",
      );
  }

  // Urgent (admin fast-track) requires the lead to have passed conflict check.
  if (urgent) {
    if (lead.status === "declined")
      throw new BadRequestError("This lead has been declined");
    if (!lead.conflictCheckId)
      throw new BadRequestError(
        "The lead must pass conflict check before urgent scheduling",
      );
    const [cc] = await db
      .select({ status: conflictChecks.status })
      .from(conflictChecks)
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .limit(1);
    if (cc?.status !== "pass")
      throw new BadRequestError(
        "The lead must pass conflict check before urgent scheduling",
      );
  }

  // Mode-specific validation: in-person consultations need a saved location.
  if (data.mode === "in_person") {
    if (!data.locationId)
      throw new BadRequestError(
        "A location is required for in-person consultations",
      );
    const [location] = await db
      .select({ id: consultationLocations.id })
      .from(consultationLocations)
      .where(
        and(
          eq(consultationLocations.id, data.locationId),
          eq(consultationLocations.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!location) throw new NotFoundError("Consultation location not found");
  }

  // Resolve the fee from the firm's consultation settings (Plan 01).
  const [settings] = await db
    .select()
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);

  let feeStatus: "none" | "unpaid" = "none";
  let feeAmount: string | null = null;
  // Kept so the invoice line can name the surcharge rather than presenting a
  // multiplied figure with no explanation.
  let baseFee: number | null = null;
  const emergencyMultiplier =
    startNow && data.isEmergency && data.emergencyMultiplier != null
      ? data.emergencyMultiplier
      : null;

  if (settings?.chargesFee) {
    const defaultAmount =
      settings.defaultAmount != null ? Number(settings.defaultAmount) : null;
    // Urgent bookings let the admin override the amount (urgency surcharge)
    // regardless of the firm's fee structure.
    const resolved =
      urgent || settings.feeStructure === "custom_per_case_type"
        ? (data.feeAmount ?? defaultAmount)
        : defaultAmount;
    if (resolved != null) {
      // The multiplier is now APPLIED, not merely recorded. The column comment
      // has always said "the multiplied amount is persisted in feeAmount" and
      // the code never did it, so an emergency surcharge only ever took effect
      // if the caller happened to pre-multiply the amount it sent.
      baseFee = resolved;
      const charged =
        emergencyMultiplier != null
          ? Math.round(resolved * emergencyMultiplier * 100) / 100
          : resolved;
      feeStatus = "unpaid";
      feeAmount = String(charged);
    }
  }

  // Instant consultations begin immediately, except pay_now with a fee, which
  // begins at payment time. A pay_now choice with no fee configured degrades
  // gracefully to begin-immediately.
  const beginsNow =
    startNow && !(feeStatus === "unpaid" && data.paymentTiming === "pay_now");

  // Urgent bookings are auto-scheduled ASAP: immediately when no fee applies,
  // otherwise at payment time. Lead-driven bookings leave scheduledAt null
  // until the lead picks a slot.
  const scheduledAt = beginsNow
    ? new Date()
    : urgent && feeStatus !== "unpaid" && !startNow
      ? nextAsapSlot()
      : null;

  const accessToken = generateAccessToken();
  const bookingExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  // Fee → payment gate; urgent no-fee is finalized right after insert; normal
  // no-fee waits for the lead to pick a slot. Instant consultations that begin
  // now are inserted as "scheduled" and flipped to in_progress by finalize.
  const status = startNow
    ? beginsNow
      ? "scheduled"
      : "pending_payment"
    : feeStatus === "unpaid"
      ? "pending_payment"
      : data.urgent
        ? "scheduled"
        : "awaiting_slot_selection";

  const [consultation] = await db
    .insert(consultations)
    .values({
      organizationId,
      leadId,
      parentConsultationId: data.parentConsultationId ?? null,
      scheduledAt,
      isUrgent: urgent,
      isInstant: startNow,
      paymentTiming: startNow ? (data.paymentTiming ?? null) : null,
      isEmergency: Boolean(startNow && data.isEmergency),
      emergencyMultiplier:
        startNow && data.isEmergency && data.emergencyMultiplier != null
          ? String(data.emergencyMultiplier)
          : null,
      autoSendQuestionnaire: Boolean(startNow && data.autoSendQuestionnaire),
      duration: data.duration,
      mode: data.mode,
      leadAttorneyId: data.leadAttorneyId,
      scheduledById: scheduledById ?? null,
      locationId: data.mode === "in_person" ? data.locationId : null,
      status,
      feeAmount,
      feeStatus,
      bookingTokenHash: tokenHash(accessToken),
      bookingExpiresAt,
      bookingStatus: "sent",
      preConsultationNotes: data.preConsultationNotes,
    })
    .returning();

  // Additional participants (the lead attorney stays on the consultation row).
  const participantIds = (data.participantStaffIds ?? []).filter(
    (id) => id !== data.leadAttorneyId,
  );
  if (participantIds.length) {
    const participantStaff = await db
      .select({ id: staff.id, role: staff.role })
      .from(staff)
      .where(
        and(
          eq(staff.organizationId, organizationId),
          inArray(staff.id, participantIds),
        ),
      );
    if (participantStaff.length) {
      await db.insert(consultationParticipants).values(
        participantStaff.map((member) => ({
          organizationId,
          consultationId: consultation.id,
          staffId: member.id,
          roleSnapshot: member.role ?? null,
        })),
      );
    }
  }

  // A chargeable consultation gets a real invoice, against the LEAD — there is
  // no client at this stage of the pipeline and there may never be one.
  //
  // Failure is swallowed on purpose: the consultation is booked, the lead has
  // been told, and losing that over a billing record would be the wrong trade.
  // The fee columns above still hold the amount, so nothing is lost — it just
  // is not on the ledger, which is the state every consultation was in before
  // this existed.
  if (feeAmount != null && feeStatus === "unpaid") {
    try {
      await raiseConsultationInvoice(organizationId, scheduledById ?? null, {
        consultationId: consultation!.id,
        leadId,
        amount: Number(feeAmount),
        baseAmount: baseFee,
        emergencyMultiplier,
        mode: data.mode,
        scheduledAt,
        // pay_now holds the consultation until the fee is settled, so it is
        // due the moment it is raised.
        dueImmediately: data.paymentTiming === "pay_now" || !startNow,
      });
    } catch (err) {
      console.error(
        `[leads] could not raise consultation invoice for ${consultation!.id}:`,
        err,
      );
    }
  }

  // Point the lead at the newest consultation. A follow-up may happen after the
  // lead has advanced past the consultation stage, so don't move it backward.
  await db
    .update(leads)
    .set({
      consultationId: consultation.id,
      ...(data.parentConsultationId
        ? {}
        : { pipelineStage: "consultation" as const }),
      updatedAt: new Date(),
    })
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)));

  // Update intake pipeline tasks for the consultation stage:
  // 1. Mark "Schedule consultation" as completed
  // 2. Assign "Conduct consultation" to the selected attorney (pending)
  if (!data.parentConsultationId) {
    const consultTasks = await db
      .select()
      .from(leadTasks)
      .where(
        and(
          eq(leadTasks.leadId, leadId),
          eq(leadTasks.organizationId, organizationId),
          eq(leadTasks.pipelineStage, "consultation"),
        ),
      );

    const scheduleTask = consultTasks.find(
      (t) => t.title === "Schedule consultation",
    );
    if (scheduleTask && scheduleTask.status !== "completed") {
      await db
        .update(leadTasks)
        .set({
          status: "completed",
          completedById: scheduledById ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(leadTasks.id, scheduleTask.id));
    }

    const conductTask = consultTasks.find(
      (t) => t.title === "Conduct consultation",
    );
    if (conductTask && data.leadAttorneyId) {
      await db
        .update(leadTasks)
        .set({
          assignedToId: data.leadAttorneyId,
          assignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(leadTasks.id, conductTask.id));
    }
  }

  // Resolve the attorney and any additional attendees to names: the trail has
  // to say who the consultation is *with*, and a uuid says nothing to a reader.
  const attendeeIds = [
    data.leadAttorneyId,
    ...(data.participantStaffIds ?? []),
  ].filter(Boolean);

  const attendees = attendeeIds.length
    ? await db
        .select({
          id: staff.id,
          firstName: staff.firstName,
          lastName: staff.lastName,
        })
        .from(staff)
        .where(
          and(
            inArray(staff.id, attendeeIds),
            eq(staff.organizationId, organizationId),
          ),
        )
    : [];

  const nameOf = (id: string) => {
    const s = attendees.find((a) => a.id === id);
    return s ? `${s.firstName} ${s.lastName}`.trim() : null;
  };

  await logLeadEvent({
    organizationId,
    leadId,
    type: "consultation_scheduled",
    actorId: scheduledById,
    metadata: {
      consultationId: consultation.id,
      mode: data.mode,
      scheduledAt: scheduledAt?.toISOString() ?? null,
      isInstant: startNow,
      isUrgent: urgent,
      isFollowUp: Boolean(data.parentConsultationId),
      leadAttorneyId: data.leadAttorneyId,
      leadAttorneyName: nameOf(data.leadAttorneyId),
      participantStaffIds: data.participantStaffIds ?? [],
      participantNames: (data.participantStaffIds ?? [])
        .map(nameOf)
        .filter(Boolean),
      feeAmount,
    },
  });

  // Pre-consultation notes were previously written to the consultation row and
  // never surfaced anywhere — not in the CRM, not in intake. Mirror them into
  // the notes trail so they are actually readable.
  await mirrorConsultationNote({
    leadId,
    organizationId,
    type: "pre_consultation",
    content: data.preConsultationNotes,
    actorId: scheduledById,
  });

  if (!data.parentConsultationId) {
    await logStageChange({
      organizationId,
      leadId,
      from: lead.pipelineStage,
      to: "consultation",
      actorId: scheduledById,
    });
  }

  // Instant consultation beginning now (invoice_after, pay_in_person, or no
  // fee): finalize immediately into in_progress (mints the Meet link and sends
  // the confirmation).
  if (startNow && beginsNow) {
    const finalized = await finalizeConsultation(consultation, { begin: true });
    return { consultation: finalized, bookingToken: accessToken };
  }

  // Urgent + no fee: connect ASAP — finalize immediately (mints the Meet link
  // and sends the confirmation). No lead action is required.
  if (!startNow && data.urgent && feeStatus !== "unpaid") {
    const finalized = await finalizeConsultation(consultation);
    return { consultation: finalized, bookingToken: accessToken };
  }

  // Email the lead the booking link. Plan 05 refines the templates and adds the
  // public token-gated booking/payment routes; here we mint the link so the
  // lead-driven flow is wired end to end.
  const bookingLink = `${env.FRONTEND_APP_URL}/consultation-booking/${accessToken}`;
  const notifyChannels = data.notifyChannels?.length
    ? data.notifyChannels
    : ["email"];

  // Instant pay_now consultations can only begin once the client pays, so the
  // payment link is always emailed regardless of the chosen channels.
  if (notifyChannels.includes("email") || startNow) {
    const needsPayment = feeStatus === "unpaid";
    const urgent = Boolean(data.urgent);
    emailService;
    const leadName = `${lead.firstName} ${lead.lastName}`;
    emailService
      .sendEmail({
        to: lead.email,
        subject: needsPayment
          ? "Action needed: pay your consultation fee"
          : "Pick a time for your consultation",
        html: needsPayment
          ? `<p>Dear ${leadName},</p>
            <p>Please pay your consultation fee of <strong>$${feeAmount}</strong>${
              urgent
                ? " to be connected with an attorney as soon as possible"
                : " and then choose a time that works for you"
            }:</p>
            <p><a href="${bookingLink}">${bookingLink}</a></p>${
              urgent
                ? "<p>You'll receive your confirmation with the scheduled time immediately after payment.</p>"
                : ""
            }`
          : `<p>Dear ${leadName},</p>
            <p>Please choose a time that works for your consultation:</p>
            <p><a href="${bookingLink}">${bookingLink}</a></p>`,
      })
      .catch(console.error);
  }

  if (notifyChannels.includes("sms") && lead.phone) {
    console.log(
      `[sms-stub] consultation booking link to ${lead.phone}: ${bookingLink}`,
    );
  }

  return { consultation, bookingToken: accessToken };
};

const getConsultation = async (leadId: string, organizationId: string) => {
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

  if (!consultation) return null;

  const participants = await db
    .select({
      id: consultationParticipants.id,
      staffId: consultationParticipants.staffId,
      roleSnapshot: consultationParticipants.roleSnapshot,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(consultationParticipants)
    .leftJoin(staff, eq(consultationParticipants.staffId, staff.id))
    .where(eq(consultationParticipants.consultationId, consultation.id));

  const consultationHistory = (
    await db
      .select()
      .from(consultations)
      .where(
        and(
          eq(consultations.leadId, leadId),
          eq(consultations.organizationId, organizationId),
        ),
      )
      .orderBy(desc(consultations.createdAt))
  ).filter((c) => c.id !== consultation.id);

  // The invoice is authoritative once one exists: "paid" then means a payment
  // is on the ledger, not that somebody flipped an enum. `feeStatus` and
  // `feeAmount` are still returned unchanged for callers that predate this.
  const fee = await consultationFee(organizationId, consultation);

  return { ...consultation, fee, participants, consultationHistory };
};

const updateConsultation = async (
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
    feeStatus: "paid";
  }>,
  actorId?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead || !lead.consultationId)
    throw new NotFoundError("No consultation found for this lead");

  const [existing] = await db
    .select()
    .from(consultations)
    .where(eq(consultations.id, lead.consultationId))
    .limit(1);
  if (!existing) throw new NotFoundError("No consultation found for this lead");

  // A consultation can't be completed or marked no-show before its start time.
  if (data.status === "completed" || data.status === "no_show") {
    if (existing.scheduledAt && existing.scheduledAt.getTime() > Date.now())
      throw new BadRequestError(
        `A consultation cannot be marked ${
          data.status === "completed" ? "completed" : "as a no-show"
        } before its scheduled start time`,
      );
  }

  // Pay-in-person (or any manual settlement): staff marks the fee received.
  if (data.feeStatus === "paid" && existing.feeStatus !== "unpaid")
    throw new ConflictError("No unpaid fee to mark as paid");

  const [updated] = await db
    .update(consultations)
    .set({
      ...data,
      mode: data.mode as any,
      status: data.status as any,
      outcome: data.outcome as any,
      updatedAt: new Date(),
    })
    .where(eq(consultations.id, lead.consultationId))
    .returning();

  if (data.status === "completed" && existing.status !== "completed") {
    await logLeadEvent({
      organizationId,
      leadId,
      type: "consultation_completed",
      actorId,
      metadata: { consultationId: updated.id, outcome: data.outcome ?? null },
    });

    // Auto-mark the linked calendar event as completed.
    await db
      .update(calendarEvents)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(calendarEvents.leadId, leadId),
          eq(calendarEvents.eventType, "client_meeting"),
          eq(calendarEvents.status, "scheduled"),
          eq(calendarEvents.organizationId, organizationId),
        ),
      );
  } else if (
    data.scheduledAt &&
    existing.scheduledAt?.getTime() !== data.scheduledAt.getTime()
  ) {
    await logLeadEvent({
      organizationId,
      leadId,
      type: "consultation_rescheduled",
      actorId,
      metadata: {
        consultationId: updated.id,
        from: existing.scheduledAt?.toISOString() ?? null,
        to: data.scheduledAt.toISOString(),
      },
    });
  }

  if (data.feeStatus === "paid" && existing.feeStatus === "unpaid") {
    await logLeadEvent({
      organizationId,
      leadId,
      type: "payment_received",
      actorId,
      metadata: {
        kind: "consultation_fee",
        consultationId: updated.id,
        amount: updated.feeAmount,
      },
    });
  }

  // Both note columns are mutable and unattributed; mirror each new value into
  // the permanent notes trail.
  await mirrorConsultationNote({
    leadId,
    organizationId,
    type: "pre_consultation",
    content: data.preConsultationNotes,
    previous: existing.preConsultationNotes,
    actorId,
  });

  await mirrorConsultationNote({
    leadId,
    organizationId,
    type: "post_consultation",
    content: data.attorneyNotes,
    previous: existing.attorneyNotes,
    actorId,
  });

  // Completion side effects (once — re-PATCHing a completed row is a no-op).
  if (data.status === "completed" && existing.status !== "completed") {
    // Invoice-after: email the payment link now that the call has ended. The
    // booking token is re-minted since only its hash is stored (this also
    // gives the client a fresh 14-day window).
    if (
      updated.paymentTiming === "invoice_after" &&
      updated.feeStatus === "unpaid"
    ) {
      const payToken = generateAccessToken();
      await db
        .update(consultations)
        .set({
          bookingTokenHash: tokenHash(payToken),
          bookingExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          bookingStatus: "sent",
          updatedAt: new Date(),
        })
        .where(eq(consultations.id, updated.id));
      const payLink = `${env.FRONTEND_APP_URL}/consultation-booking/${payToken}`;
      emailService
        .sendEmail({
          to: lead.email,
          subject: "Your consultation is complete — payment link inside",
          html: `<p>Dear ${lead.firstName} ${lead.lastName},</p>
            <p>Thank you for your consultation. Please pay your consultation fee of <strong>$${updated.feeAmount}</strong>:</p>
            <p><a href="${payLink}">${payLink}</a></p>`,
        })
        .catch(console.error);
    }

    // Auto-send the intake questionnaire when requested and the lead has never
    // been sent one. Skipped silently when the lead has no case type yet.
    if (updated.autoSendQuestionnaire && !lead.questionnaireSendId) {
      const [leadCaseType] = await db
        .select({ id: leads.caseTypeId })
        .from(leads)
        .where(
          and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
        )
        .limit(1);
      if (leadCaseType?.id) {
        await sendQuestionnaire(leadId, organizationId, undefined, {
          language: lead.language ?? undefined,
        }).catch(console.error);
      } else {
        console.warn(
          `[consultation] skipping auto-questionnaire for lead ${leadId}: no case type assigned`,
        );
      }
    }
  }

  return updated;
};

const getConsultations = async (
  organizationId: string,
  filters: Partial<PaginationParams> & {
    search?: string;
    attorneyId?: string;
    sort?: string;
  } = {},
) => {
  const conditions = [eq(consultations.organizationId, organizationId)];
  if (filters.attorneyId)
    conditions.push(eq(consultations.leadAttorneyId, filters.attorneyId));
  if (filters.search)
    conditions.push(
      or(
        ilike(leads.firstName, `%${filters.search}%`),
        ilike(leads.lastName, `%${filters.search}%`),
      )!,
    );

  const where = and(...conditions);

  const orderBy = (() => {
    switch (filters.sort) {
      case "date_desc":
        return [desc(consultations.scheduledAt)];
      case "client_asc":
        return [asc(leads.firstName), asc(leads.lastName)];
      case "client_desc":
        return [desc(leads.firstName), desc(leads.lastName)];
      case "date_asc":
      default:
        return [asc(consultations.scheduledAt)];
    }
  })();

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [countRow] = await db
    .select({ total: count() })
    .from(consultations)
    .innerJoin(leads, eq(consultations.leadId, leads.id))
    .where(where);

  const rows = await db
    .select({
      id: consultations.id,
      leadId: consultations.leadId,
      leadName: sql`concat(${leads.firstName}, ' ', ${leads.lastName})`,
      leadEmail: leads.email,
      mode: consultations.mode,
      status: consultations.status,
      scheduledAt: consultations.scheduledAt,
      duration: consultations.duration,
      feeStatus: consultations.feeStatus,
      feeAmount: consultations.feeAmount,
      leadAttorneyId: consultations.leadAttorneyId,
      attorneyFirstName: staff.firstName,
      attorneyLastName: staff.lastName,
    })
    .from(consultations)
    .innerJoin(leads, eq(consultations.leadId, leads.id))
    .leftJoin(staff, eq(consultations.leadAttorneyId, staff.id))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  return buildPaginatedResponse(rows, {
    page,
    limit,
    total: Number(countRow?.total ?? 0),
  });
};

// ─── Public booking flow (lead-facing, token-gated) ─────────────────────────────

const getConsultationByBookingToken = async (
  token: string,
  markOpened = false,
) => {
  const [consultation] = await db
    .select()
    .from(consultations)
    .where(eq(consultations.bookingTokenHash, tokenHash(token)))
    .limit(1);

  if (!consultation) throw new NotFoundError("Booking link not found");
  if (consultation.bookingStatus === "revoked")
    throw new ConflictError("This booking link has been revoked");

  if (
    consultation.bookingExpiresAt &&
    consultation.bookingExpiresAt.getTime() < Date.now()
  ) {
    if (consultation.bookingStatus !== "expired") {
      await db
        .update(consultations)
        .set({ bookingStatus: "expired", updatedAt: new Date() })
        .where(eq(consultations.id, consultation.id));
    }
    throw new ConflictError("This booking link has expired");
  }

  if (markOpened && consultation.bookingStatus === "sent") {
    await db
      .update(consultations)
      .set({ bookingStatus: "opened", updatedAt: new Date() })
      .where(eq(consultations.id, consultation.id));
    consultation.bookingStatus = "opened";
  }

  return consultation;
};

const getConsultationBooking = async (token: string) => {
  const consultation = await getConsultationByBookingToken(token, true);

  const [lead] = await db
    .select({ firstName: leads.firstName, lastName: leads.lastName })
    .from(leads)
    .where(eq(leads.id, consultation.leadId))
    .limit(1);

  const [firm] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, consultation.organizationId))
    .limit(1);

  const firmTimezone = await getFirmTimezone(consultation.organizationId);

  const requiresPayment = consultation.feeStatus === "unpaid";

  // Slots are only offered once any fee is settled and a time isn't yet chosen.
  // Gating on awaiting_slot_selection keeps instant consultations (paid after
  // completion) from ever showing the slot picker.
  const slots =
    !requiresPayment &&
    consultation.status === "awaiting_slot_selection" &&
    consultation.bookingStatus !== "slot_selected" &&
    consultation.leadAttorneyId
      ? await generateConsultationSlots(
          consultation.organizationId,
          consultation.leadAttorneyId,
          { durationMinutes: consultation.duration },
        )
      : [];

  const leadName = lead ? `${lead.firstName} ${lead.lastName}` : null;

  await logLeadEvent({
    organizationId: consultation.organizationId,
    leadId: consultation.leadId,
    type: "consultation_booking_opened",
    metadata: { consultationId: consultation.id },
  });

  return {
    firmName: firm?.name ?? null,
    leadName,
    firmTimezone,
    leadTimezone: null,
    mode: consultation.mode,
    durationMinutes: consultation.duration,
    requiresPayment,
    isUrgent: consultation.isUrgent,
    status: consultation.status,
    // From the invoice when there is one, so the lead is quoted the amount the
    // firm is actually owed rather than a column that may predate it.
    fee: await consultationFee(consultation.organizationId, consultation),
    scheduledAt: consultation.scheduledAt,
    bookingStatus: consultation.bookingStatus,
    slots,
  };
};

/** Resolve a lead's timezone, falling back to the firm zone when unset. */
const getLeadTimezone = async (
  leadId: string,
  organizationId: string,
): Promise<string> => {
  const [lead] = await db
    .select({ timezone: leads.timezone })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  return lead?.timezone ?? getFirmTimezone(organizationId);
};

/**
 * The lead-facing "pay" action on the booking page.
 *
 * **This does not take money and must not write to the ledger.** There is no
 * payment provider wired anywhere in this repo; the button has always been a
 * dummy that flips flags. What changed is that consultation fees are now real
 * invoices, so pretending here would put payments in `invoice_payments` that
 * never happened — turning a UI that overstates itself into accounts that do.
 *
 * So the split is deliberate:
 *
 *   - `consultations.feeStatus` is flipped, because it gates the consultation
 *     LIFECYCLE — whether the call starts, whether a slot can be picked. That
 *     is a product decision already made and this keeps the demo flow working.
 *   - The invoice is left alone. It stays outstanding and keeps appearing in
 *     receivables, which is the truth: nobody has paid. Staff record the real
 *     payment through the finance module when it arrives.
 *
 * Phase 3 replaces this with a provider, at which point the webhook records the
 * payment and the two stop disagreeing.
 */
const payConsultationFee = async (token: string) => {
  const consultation = await getConsultationByBookingToken(token);
  if (consultation.feeStatus !== "unpaid")
    throw new ConflictError("No payment is required for this consultation");

  // Instant consultations: pay_now begins the consultation at payment time;
  // invoice_after / pay_in_person fees paid after the call just get marked
  // paid (nothing left to start).
  if (consultation.isInstant) {
    const begins = consultation.status === "pending_payment";
    const [paid] = await db
      .update(consultations)
      .set({
        feeStatus: "paid",
        bookingStatus: "paid",
        ...(begins ? { scheduledAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(consultations.id, consultation.id))
      .returning();
    if (begins) await finalizeConsultation(paid, { begin: true });

    await logLeadEvent({
      organizationId: consultation.organizationId,
      leadId: consultation.leadId,
      type: "payment_received",
      metadata: {
        consultationId: consultation.id,
        amount: Number(consultation.feeAmount),
        instant: true,
        // No provider is wired, so no money actually moved and the invoice is
        // deliberately untouched. Recorded so the trail does not read as a
        // settled payment.
        demo: true,
      },
    });

    return { success: true };
  }

  // Dummy payment: flip the fee flags. Urgent consultations are auto-scheduled
  // ASAP at payment time and finalized immediately (connect ASAP) rather than
  // sending the lead back to pick a slot. Legacy urgent rows created with an
  // admin-chosen time keep it (the !scheduledAt guard).
  const asapAt =
    consultation.isUrgent && !consultation.scheduledAt ? nextAsapSlot() : null;
  const [paid] = await db
    .update(consultations)
    .set({
      feeStatus: "paid",
      bookingStatus: "paid",
      status: consultation.isUrgent
        ? consultation.status
        : "awaiting_slot_selection",
      ...(asapAt ? { scheduledAt: asapAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(consultations.id, consultation.id))
    .returning();

  if (consultation.isUrgent) {
    await finalizeConsultation(paid);

    await logLeadEvent({
      organizationId: consultation.organizationId,
      leadId: consultation.leadId,
      type: "payment_received",
      metadata: {
        consultationId: consultation.id,
        amount: Number(consultation.feeAmount),
        urgent: true,
      },
    });

    return { success: true };
  }

  const [lead] = await db
    .select({
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
    })
    .from(leads)
    .where(eq(leads.id, consultation.leadId))
    .limit(1);

  if (lead) {
    const leadName = `${lead.firstName} ${lead.lastName}`;
    const bookingLink = `${env.FRONTEND_APP_URL}/consultation-booking/${token}`;
    emailService
      .sendEmail({
        to: lead.email,
        subject: "Payment received — pick a time for your consultation",
        html: `<p>Dear ${leadName},</p>
          <p>Thanks, your payment was received. Please choose a time that works for you:</p>
          <p><a href="${bookingLink}">${bookingLink}</a></p>`,
      })
      .catch(console.error);
  }

  await logLeadEvent({
    organizationId: consultation.organizationId,
    leadId: consultation.leadId,
    type: "payment_received",
    metadata: {
      consultationId: consultation.id,
      amount: Number(consultation.feeAmount),
    },
  });

  return { success: true };
};

// Gathers the people to notify about a consultation: the lead, the lead
// attorney (email + phone), and any additional participants. Shared by the
// confirmation and cancellation emails.
const getConsultationRecipients = async (
  consultation: typeof consultations.$inferSelect,
) => {
  const [lead] = await db
    .select({
      firstName: leads.firstName,
      lastName: leads.lastName,
      email: leads.email,
    })
    .from(leads)
    .where(
      and(
        eq(leads.id, consultation.leadId),
        eq(leads.organizationId, consultation.organizationId),
      ),
    )
    .limit(1);

  let attorney:
    | { firstName: string; email: string | null; phone: string | null }
    | undefined;
  if (consultation.leadAttorneyId) {
    [attorney] = await db
      .select({
        firstName: staff.firstName,
        email: user.email,
        phone: staff.phone,
      })
      .from(staff)
      .leftJoin(user, eq(staff.userId, user.id))
      .where(
        and(
          eq(staff.id, consultation.leadAttorneyId),
          eq(staff.organizationId, consultation.organizationId),
        ),
      )
      .limit(1);
  }

  const participants = await db
    .select({ email: user.email })
    .from(consultationParticipants)
    .leftJoin(staff, eq(consultationParticipants.staffId, staff.id))
    .leftJoin(user, eq(staff.userId, user.id))
    .where(
      and(
        eq(consultationParticipants.consultationId, consultation.id),
        eq(
          consultationParticipants.organizationId,
          consultation.organizationId,
        ),
      ),
    );

  const staffEmails = [
    attorney?.email,
    ...participants.map((p) => p.email),
  ].filter((email): email is string => Boolean(email));

  return { lead, attorney, staffEmails };
};

const sendConsultationConfirmation = async (
  consultation: typeof consultations.$inferSelect,
) => {
  const { lead, attorney, staffEmails } =
    await getConsultationRecipients(consultation);
  if (!lead) return;

  // Localize the time per audience, always with an explicit zone label: the
  // lead sees their own zone (plus firm time), staff see the firm zone.
  const firmTz = await getFirmTimezone(consultation.organizationId);
  const leadTz = await getLeadTimezone(
    consultation.leadId,
    consultation.organizationId,
  );
  const leadScheduledStr = consultation.scheduledAt
    ? formatDualZone(consultation.scheduledAt, leadTz, firmTz)
    : "TBD";
  const staffScheduledStr = consultation.scheduledAt
    ? formatWithZone(consultation.scheduledAt, firmTz)
    : "TBD";

  // Mode-specific meeting detail.
  let meetingDetail = "";
  if (consultation.mode === "video" && consultation.videoLink) {
    meetingDetail = `<p><strong>Join link:</strong> <a href="${consultation.videoLink}">${consultation.videoLink}</a></p>`;
  } else if (consultation.mode === "phone_call") {
    meetingDetail = attorney?.phone
      ? `<p><strong>Phone:</strong> ${attorney.phone}</p>`
      : `<p>Your attorney will call you at the scheduled time.</p>`;
  } else if (consultation.mode === "in_person" && consultation.locationId) {
    const [location] = await db
      .select()
      .from(consultationLocations)
      .where(eq(consultationLocations.id, consultation.locationId))
      .limit(1);
    if (location) {
      const address = [
        location.addressLine1,
        location.addressLine2,
        location.city,
        location.state,
        location.zipCode,
      ]
        .filter(Boolean)
        .join(", ");
      meetingDetail = `<p><strong>Location:</strong> ${location.label}${
        address ? ` — ${address}` : ""
      }</p>`;
    }
  }

  const leadName = `${lead.firstName} ${lead.lastName}`;
  emailService
    .sendEmail({
      to: lead.email,
      subject: "Your consultation is confirmed",
      html: `<p>Dear ${leadName},</p>
        <p>Your consultation is confirmed for <strong>${leadScheduledStr}</strong>.</p>
        ${meetingDetail}
        <p>We look forward to speaking with you.</p>`,
    })
    .catch(console.error);

  for (const email of staffEmails) {
    emailService
      .sendEmail({
        to: email,
        subject: `Consultation confirmed: ${leadName}`,
        html: `<p>A consultation with <strong>${leadName}</strong> is confirmed for <strong>${staffScheduledStr}</strong>.</p>
          ${meetingDetail}`,
      })
      .catch(console.error);
  }
};

// Finalize a consultation whose scheduledAt is already set: mint the Meet link
// (video, when not already present), flip to scheduled, and send confirmations.
// Shared by the lead slot-selection flow and urgent scheduling (both the
// no-fee-at-initiate and the pay-then-connect paths).
const finalizeConsultation = async (
  consultation: typeof consultations.$inferSelect,
  opts: { begin?: boolean } = {},
) => {
  const start = consultation.scheduledAt;
  if (!start)
    throw new BadRequestError("Consultation has no scheduled time to finalize");

  let videoLink = consultation.videoLink;
  let meetExternalId = consultation.meetExternalId;
  if (consultation.mode === "video" && !videoLink) {
    const [lead] = await db
      .select({ firstName: leads.firstName, lastName: leads.lastName })
      .from(leads)
      .where(eq(leads.id, consultation.leadId))
      .limit(1);
    const leadName = lead ? `${lead.firstName} ${lead.lastName}` : "client";
    const meet = await googleMeetService.createMeetLink({
      summary: `Consultation with ${leadName}`,
      startTime: start,
      durationMinutes: consultation.duration,
    });
    videoLink = meet.url;
    meetExternalId = meet.externalId ?? null;
  }

  const [updated] = await db
    .update(consultations)
    .set({
      scheduledAt: start,
      // Instant consultations begin the moment they are finalized.
      status: opts.begin ? "in_progress" : "scheduled",
      bookingStatus: "slot_selected",
      videoLink,
      meetExternalId,
      updatedAt: new Date(),
    })
    .where(eq(consultations.id, consultation.id))
    .returning();

  // Auto-create a calendar event for the finalized consultation.
  try {
    const [leadRow] = await db
      .select({ firstName: leads.firstName, lastName: leads.lastName })
      .from(leads)
      .where(eq(leads.id, consultation.leadId))
      .limit(1);

    const leadName = leadRow
      ? `${leadRow.firstName} ${leadRow.lastName}`
      : "Unknown";

    const end = new Date(start.getTime() + consultation.duration * 60 * 1000);
    const modeLabel =
      consultation.mode === "video"
        ? "Video"
        : consultation.mode === "in_person"
          ? "In-person"
          : "Phone";

    await db.insert(calendarEvents).values({
      organizationId: consultation.organizationId,
      eventType: "client_meeting",
      status: "scheduled",
      title: `Consultation — ${leadName}`,
      startTime: start,
      endTime: end,
      leadId: consultation.leadId,
      assignedStaffId: consultation.leadAttorneyId,
      location: modeLabel + (videoLink ? ` — ${videoLink}` : ""),
      notes: consultation.preConsultationNotes,
      isAutoGenerated: false,
    });
  } catch (err) {
    // Non-fatal: calendar event creation failure must not block consultation
    console.error("Failed to auto-create calendar event for consultation", err);
  }

  await sendConsultationConfirmation(updated);
  return updated;
};

const selectConsultationSlot = async (token: string, startIso: string) => {
  const consultation = await getConsultationByBookingToken(token);

  if (consultation.feeStatus === "unpaid")
    throw new ConflictError("Payment is required before selecting a time");
  if (
    consultation.bookingStatus === "slot_selected" ||
    consultation.status === "scheduled"
  )
    throw new ConflictError(
      "A time has already been selected for this consultation",
    );
  if (!consultation.leadAttorneyId)
    throw new BadRequestError("No attorney is assigned to this consultation");

  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new BadRequestError("Invalid time");

  // Re-validate availability to guard against double-booking.
  const slots = await generateConsultationSlots(
    consultation.organizationId,
    consultation.leadAttorneyId,
    { durationMinutes: consultation.duration },
  );
  if (!slots.some((slot) => slot.start === start.toISOString()))
    throw new ConflictError(
      "That time is no longer available. Please choose another.",
    );

  // Persist the chosen slot, then finalize (Meet link + confirmation emails).
  consultation.scheduledAt = start;
  await finalizeConsultation(consultation);

  await logLeadEvent({
    organizationId: consultation.organizationId,
    leadId: consultation.leadId,
    type: "consultation_slot_selected",
    metadata: { consultationId: consultation.id, slot: startIso },
  });

  return { success: true, scheduledAt: start.toISOString() };
};

// Cancels the lead's active consultation with side effects: revoke the booking
// link, remove the Google Meet event, and notify the lead + attorney +
// participants. The active-consultation guard in initiateConsultation then lets
// the lead be re-scheduled. `leadId` is the lead id (route :id).
const cancelConsultation = async (
  leadId: string,
  organizationId: string,
  data: { reason?: string } = {},
  actorId?: string,
) => {
  const [lead] = await db
    .select({ consultationId: leads.consultationId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);
  if (!lead?.consultationId)
    throw new NotFoundError("No consultation found for this lead");

  const [consultation] = await db
    .select()
    .from(consultations)
    .where(
      and(
        eq(consultations.id, lead.consultationId),
        eq(consultations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!consultation) throw new NotFoundError("Consultation not found");

  const terminal = ["cancelled", "completed", "no_show"];
  if (terminal.includes(consultation.status))
    throw new ConflictError(
      `Consultation is already ${consultation.status.replace(/_/g, " ")}`,
    );

  const [updated] = await db
    .update(consultations)
    .set({
      status: "cancelled",
      bookingStatus: "revoked",
      cancelledAt: new Date(),
      cancelledById: actorId ?? null,
      cancellationReason: data.reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(consultations.id, consultation.id))
    .returning();

  // Auto-cancel the linked calendar event for this consultation.
  await db
    .update(calendarEvents)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(calendarEvents.leadId, consultation.leadId),
        eq(calendarEvents.eventType, "client_meeting"),
        eq(calendarEvents.status, "scheduled"),
        eq(calendarEvents.organizationId, organizationId),
      ),
    );

  await logLeadEvent({
    organizationId,
    leadId,
    type: "consultation_cancelled",
    actorId,
    metadata: {
      consultationId: consultation.id,
      reason: data.reason ?? null,
    },
  });

  // Detach the cancelled consultation from the lead so it no longer counts as
  // the lead's active consultation: the lead drops out of the "in progress"
  // list and can be scheduled again. The row itself is kept (visible under the
  // lead's consultation history). Pipeline stage is left untouched.
  await db
    .update(leads)
    .set({ consultationId: null, updatedAt: new Date() })
    .where(eq(leads.id, leadId));

  // Remove the calendar/Meet event (no-op for placeholder/unconfigured).
  await googleMeetService.deleteMeetEvent(consultation.meetExternalId);

  // Dummy fee: no real refund is processed this phase; feeStatus is left as-is.

  const { lead: leadRow, staffEmails } =
    await getConsultationRecipients(updated);
  const firmTz = await getFirmTimezone(updated.organizationId);
  const leadTz = await getLeadTimezone(updated.leadId, updated.organizationId);
  const leadWhen = updated.scheduledAt
    ? ` scheduled for <strong>${formatDualZone(updated.scheduledAt, leadTz, firmTz)}</strong>`
    : "";
  const staffWhen = updated.scheduledAt
    ? ` scheduled for <strong>${formatWithZone(updated.scheduledAt, firmTz)}</strong>`
    : "";
  const reasonLine = data.reason
    ? `<p><strong>Reason:</strong> ${data.reason}</p>`
    : "";

  const leadRowName = leadRow
    ? `${leadRow.firstName} ${leadRow.lastName}`
    : null;
  if (leadRow) {
    emailService
      .sendEmail({
        to: leadRow.email,
        subject: "Your consultation has been cancelled",
        html: `<p>Dear ${leadRowName},</p>
          <p>Your consultation${leadWhen} has been cancelled.</p>
          ${reasonLine}
          <p>Please contact our office if you would like to re-schedule.</p>`,
      })
      .catch(console.error);
  }
  for (const email of staffEmails) {
    emailService
      .sendEmail({
        to: email,
        subject: `Consultation cancelled: ${leadRowName ?? "client"}`,
        html: `<p>The consultation with <strong>${
          leadRowName ?? "the client"
        }</strong>${staffWhen} has been cancelled.</p>
          ${reasonLine}`,
      })
      .catch(console.error);
  }

  return updated;
};

// ─── Fee Agreement ─────────────────────────────────────────────────────────────

// True when the case-opening payment requirement is met. Contingency
// agreements never require an upfront payment; legacy rows without details
// predate payment tracking and are never blocked. FEE_PAYMENT_GATE_BYPASS is
// the dev-only escape hatch (forced off in production).
const feeAgreementPaymentSatisfied = (
  details: FeeAgreementDetails | null | undefined,
): boolean =>
  env.FEE_PAYMENT_GATE_BYPASS ||
  !details ||
  details.attorneyFee.type === "contingency" ||
  Boolean(details.paymentReceivedAt);

const generateFeeAgreement = async (
  leadId: string,
  organizationId: string,
  data: {
    agreementType?: string;
    generatedFrom?: "questionnaire_auto" | "manual";
    attorneyFee: FeeAgreementDetails["attorneyFee"];
    // Wire shape: abaConfirmed flag instead of the server-stamped timestamp.
    contingencyTerms?: Omit<
      NonNullable<FeeAgreementDetails["contingencyTerms"]>,
      "abaConfirmedAt"
    > & { abaConfirmed: true };
    governmentFees?: FeeAgreementDetails["governmentFees"];
    otherCosts?: FeeAgreementDetails["otherCosts"];
    governmentFeesPaidBy?: FeeAgreementDetails["governmentFeesPaidBy"];
    paymentPlan?: FeeAgreementDetails["paymentPlan"];
    twoPaymentsSchedule?: FeeAgreementDetails["twoPaymentsSchedule"];
    installmentSchedule?: FeeAgreementDetails["installmentSchedule"];
    paymentAllocation?: FeeAgreementDetails["paymentAllocation"];
    applyConsultationCredit?: boolean;
    accountSplit?: FeeAgreementDetails["accountSplit"];
  },
  actorId?: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  // Unlocks once the lead has completed *any* consultation — a later follow-up
  // being cancelled (which detaches lead.consultationId) must not re-block this.
  const [completedConsultation] = await db
    .select({ id: consultations.id })
    .from(consultations)
    .where(
      and(
        eq(consultations.leadId, leadId),
        eq(consultations.status, "completed"),
      ),
    )
    .limit(1);
  if (!completedConsultation)
    throw new BadRequestError(
      "A consultation must be completed before generating a fee agreement",
    );
  if (lead.feeAgreementId)
    throw new ConflictError("Fee agreement already exists for this lead");

  // Resolve the consultation fee for the credit note: the lead's own
  // consultation fee if set, else the firm's default.
  let consultationFeeAmount: number | null = null;
  if (lead.consultationId) {
    const [c] = await db
      .select({ feeAmount: consultations.feeAmount })
      .from(consultations)
      .where(eq(consultations.id, lead.consultationId))
      .limit(1);
    if (c?.feeAmount != null) consultationFeeAmount = Number(c.feeAmount);
  }
  if (consultationFeeAmount == null) {
    const [settings] = await db
      .select({ defaultAmount: consultationSettings.defaultAmount })
      .from(consultationSettings)
      .where(eq(consultationSettings.organizationId, organizationId))
      .limit(1);
    if (settings?.defaultAmount != null)
      consultationFeeAmount = Number(settings.defaultAmount);
  }

  // Per-firm document reference, e.g. FA-2026-0011.
  const [countRow] = await db
    .select({ total: count() })
    .from(feeAgreements)
    .where(eq(feeAgreements.organizationId, organizationId));
  const docRef = `FA-${new Date().getFullYear()}-${String(
    Number(countRow?.total ?? 0) + 1,
  ).padStart(4, "0")}`;

  const details: FeeAgreementDetails = {
    attorneyFee: data.attorneyFee,
    ...(data.contingencyTerms
      ? {
          contingencyTerms: {
            coversCaseCosts: data.contingencyTerms.coversCaseCosts,
            coversExpertWitnessFees:
              data.contingencyTerms.coversExpertWitnessFees,
            ifLost: data.contingencyTerms.ifLost,
            // Stamped server-side; the client only sends the confirmation flag.
            abaConfirmedAt: new Date().toISOString(),
          },
        }
      : {}),
    governmentFees: data.governmentFees ?? [],
    ...(data.otherCosts?.length ? { otherCosts: data.otherCosts } : {}),
    governmentFeesPaidBy: data.governmentFeesPaidBy ?? "client_upfront",
    paymentPlan: data.paymentPlan ?? "pay_in_full",
    // Schedules persist only when they match the chosen plan; anything else
    // sent by a stale client is dropped.
    ...(data.paymentPlan === "two_payments" && data.twoPaymentsSchedule
      ? { twoPaymentsSchedule: data.twoPaymentsSchedule }
      : {}),
    ...(data.paymentPlan === "installments" && data.installmentSchedule
      ? { installmentSchedule: data.installmentSchedule }
      : {}),
    ...(data.paymentAllocation
      ? { paymentAllocation: data.paymentAllocation }
      : {}),
    applyConsultationCredit: data.applyConsultationCredit ?? false,
    accountSplit: data.accountSplit ?? { operating: 0, trust: 0 },
    consultationFeeAmount,
    docRef,
  };

  // Create the agreement as a draft only. The signing envelope is minted and the
  // client is emailed at the separate "send" step; the lead stays in the
  // consultation stage until the signed document is received.
  const [agreement] = await db
    .insert(feeAgreements)
    .values({
      organizationId,
      leadId,
      practiceAreaId: undefined,
      caseTypeId: undefined,
      agreementType: data.agreementType ?? "retainer",
      details,
      generatedFrom: (data.generatedFrom ?? "manual") as any,
      status: "draft",
      generatedById: actorId ?? null,
    })
    .returning();

  await db
    .update(leads)
    .set({ feeAgreementId: agreement.id, updatedAt: new Date() })
    .where(eq(leads.id, leadId));

  await logLeadEvent({
    organizationId,
    leadId,
    type: "fee_agreement_generated",
    actorId,
    metadata: {
      agreementId: agreement.id,
      feeType: details.attorneyFee?.type ?? null,
    },
  });

  const document = await assembleFeeAgreementDocument(
    agreement,
    organizationId,
  );
  return { agreement, document };
};

// Discard a drafted agreement so it can be reconfigured and regenerated.
// Drafts only: nothing has been dispatched yet (no envelope, no signing token,
// no uploaded PDF), so the row is hard-deleted and the lead's pointer cleared —
// generateFeeAgreement's one-agreement-per-lead guard then allows a fresh one.
const discardDraftFeeAgreement = async (
  agreementId: string,
  organizationId: string,
) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status !== "draft")
    throw new BadRequestError(
      "Only draft agreements can be discarded — this one has already been sent",
    );

  await withTransaction(db, async () => {
    await db
      .update(leads)
      .set({ feeAgreementId: null, updatedAt: new Date() })
      .where(
        and(
          eq(leads.id, agreement.leadId),
          eq(leads.feeAgreementId, agreementId),
        ),
      );
    await db.delete(feeAgreements).where(eq(feeAgreements.id, agreementId));
  });

  await logLeadEvent({
    organizationId,
    leadId: agreement.leadId,
    type: "fee_agreement_discarded",
    metadata: { agreementId },
  });

  // The stored config is returned so the client can seed the wizard with it.
  return {
    discarded: true,
    agreementId,
    leadId: agreement.leadId,
    details: agreement.details,
  };
};

// Dispatch a drafted agreement: mint the e-signature envelope, email the client
// the signing link, and move the agreement to pending_signature. The lead stays
// in the consultation stage.
const sendFeeAgreement = async (
  agreementId: string,
  organizationId: string,
  actorId?: string,
) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status !== "draft")
    throw new BadRequestError("Only a draft agreement can be sent");

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, agreement.leadId))
    .limit(1);
  if (!lead) throw new NotFoundError("Lead not found");

  // Render the fee-agreement PDF server-side and persist it to R2. This is the
  // document that gets sent for signature; the stub provider is still used to
  // mint the (fake) envelope until the Dropbox Sign provider is wired in.
  const documentData = await assembleFeeAgreementDocument(
    agreement,
    organizationId,
  );
  const pdfBuffer = await renderFeeAgreementPdf(documentData);
  const documentKey = `fee-agreements/${organizationId}/${agreement.id}/generated.pdf`;
  await storageService.upload({
    key: documentKey,
    body: pdfBuffer,
    contentType: "application/pdf",
  });

  // Create the embedded signature request (Dropbox Sign, or the stub fallback).
  // No email is sent by the provider — the client signs on our own signing page.
  const provider = getESignatureProvider();
  const leadName = `${lead.firstName} ${lead.lastName}`;
  const { signatureRequestId, signerSignatureId } =
    await provider.createEmbeddedRequest({
      signer: { email: lead.email, name: leadName },
      file: pdfBuffer,
      fileName: `${documentData.docRef || agreement.id}.pdf`,
      title: `Fee Agreement — ${leadName}`,
      subject: "Please sign your fee agreement",
      metadata: {
        agreementId: agreement.id,
        leadId: agreement.leadId,
        organizationId,
      },
      testMode: env.DROPBOX_SIGN_TEST_MODE,
    });

  // Opaque token backing the public, client-facing signing page URL (the raw
  // embedded sign URL is minted on demand and never emailed — it expires fast).
  const signingToken = randomUUID();
  const signingLink = `${env.FRONTEND_APP_URL}/sign/${signingToken}`;

  const now = new Date();
  const [updated] = await db
    .update(feeAgreements)
    .set({
      status: "pending_signature",
      envelopeId: signatureRequestId,
      signerSignatureId,
      signingToken,
      signingLink,
      documentUrl: documentKey,
      sentById: actorId ?? null,
      updatedAt: now,
    })
    .where(eq(feeAgreements.id, agreementId))
    .returning();

  await logLeadEvent({
    organizationId,
    leadId: agreement.leadId,
    type: "fee_agreement_sent",
    actorId,
    metadata: { agreementId },
  });

  emailService
    .sendEmail({
      to: lead.email,
      subject: "Please sign your fee agreement",
      html: `<p>Dear ${lead.firstName},</p>
        <p>Your fee agreement is ready for signature. Please click the link below to review and sign:</p>
        <p><a href="${signingLink}">Sign Agreement</a></p>
        <p>Please complete this at your earliest convenience.</p>`,
    })
    .catch(console.error);

  return { ...updated, clientSigningLink: signingLink };
};

/**
 * Move a lead to case_opening, emitting the stage_changed event the funnel
 * metrics depend on. Several flows reach this stage (manual receipt, the
 * e-signature webhook, payment landing last), so the read-then-write lives in
 * one place rather than being repeated at each call site.
 */
const advanceLeadToCaseOpening = async (
  leadId: string,
  organizationId: string,
  now: Date,
  actorId?: string | null,
) => {
  const [lead] = await db
    .select({ pipelineStage: leads.pipelineStage })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  await db
    .update(leads)
    .set({ pipelineStage: "case_opening", updatedAt: now })
    .where(eq(leads.id, leadId));

  if (lead) {
    await logStageChange({
      organizationId,
      leadId,
      from: lead.pipelineStage,
      to: "case_opening",
      actorId,
    });
  }
};

// Staff manually confirms receipt of the signed document: mark the agreement
// signed and advance the lead to the case-opening stage (the manual equivalent
// of the e-signature webhook).
const markFeeAgreementReceived = async (
  agreementId: string,
  organizationId: string,
  actorId?: string,
) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status !== "pending_signature" && agreement.status !== "signed")
    throw new BadRequestError(
      "The agreement must be sent before it can be marked as received",
    );

  const now = new Date();
  if (agreement.status !== "signed") {
    await db
      .update(feeAgreements)
      .set({
        status: "signed",
        clientSignedAt: now,
        receivedById: actorId ?? null,
        updatedAt: now,
      })
      .where(eq(feeAgreements.id, agreementId));

    await logLeadEvent({
      organizationId,
      leadId: agreement.leadId,
      type: "fee_agreement_signed",
      actorId,
      metadata: { agreementId, markedManually: true },
    });
  }

  // Advance only once the payment gate is also satisfied; otherwise the lead
  // stays in the consultation stage, whose agreement card offers the
  // "Mark payment received" action.
  if (feeAgreementPaymentSatisfied(agreement.details)) {
    await advanceLeadToCaseOpening(
      agreement.leadId,
      organizationId,
      now,
      actorId,
    );
  }

  return { received: true, agreementId, leadId: agreement.leadId };
};

// Staff records that the client's upfront payment was received. This is the
// payment half of the case-opening gate for non-contingency agreements; when
// the agreement is already signed, recording payment auto-advances the lead.
// Allowed from any non-voided status — firms often collect payment at signing.
const markFeeAgreementPaymentReceived = async (
  agreementId: string,
  organizationId: string,
  actorId?: string,
) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status === "voided")
    throw new BadRequestError("A voided agreement cannot be marked as paid");
  if (!agreement.details)
    throw new BadRequestError("This agreement predates payment tracking");

  // Idempotent: repeat calls keep the original timestamp.
  let paymentReceivedAt = agreement.details.paymentReceivedAt ?? null;
  const now = new Date();
  if (!paymentReceivedAt) {
    paymentReceivedAt = now.toISOString();
    await db
      .update(feeAgreements)
      .set({
        details: { ...agreement.details, paymentReceivedAt },
        updatedAt: now,
      })
      .where(eq(feeAgreements.id, agreementId));

    // Only log on the first (real) receipt — a repeat call is a no-op, and the
    // trail must not imply the client paid twice.
    await logLeadEvent({
      organizationId,
      leadId: agreement.leadId,
      type: "payment_received",
      actorId,
      metadata: { kind: "fee_agreement", agreementId },
    });
  }

  // Payment was the last missing gate condition once signed.
  if (agreement.status === "signed") {
    await advanceLeadToCaseOpening(
      agreement.leadId,
      organizationId,
      now,
      actorId,
    );
  }

  return {
    paymentReceived: true,
    agreementId,
    leadId: agreement.leadId,
    paymentReceivedAt,
  };
};

const getFeeAgreement = async (leadId: string, organizationId: string) => {
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

// Returns a drafted agreement plus its assembled preview document (so the
// preview modal can be reopened for a draft).
const getFeeAgreementPreview = async (
  agreementId: string,
  organizationId: string,
) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");

  const document = await assembleFeeAgreementDocument(
    agreement,
    organizationId,
  );
  return { agreement, document };
};

const nudgeClient = async (agreementId: string, organizationId: string) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(
      and(
        eq(feeAgreements.id, agreementId),
        eq(feeAgreements.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!agreement) throw new NotFoundError("Agreement not found");
  if (agreement.status === "signed")
    throw new ConflictError("Agreement is already signed");

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
    html: `<p>Dear ${lead.firstName},</p>
      <p>This is a friendly reminder to sign your fee agreement:</p>
      ${agreement.signingLink ? `<p><a href="${agreement.signingLink}">Sign Agreement</a></p>` : ""}
      <p>Please complete this as soon as possible to proceed with your case.</p>`,
  });

  await logLeadEvent({
    organizationId,
    leadId: lead.id,
    type: "nudge_sent",
    metadata: { agreementId },
  });

  return { reminderSentAt: now };
};

// ─── Embedded signing session (public, token-gated) ─────────────────────────

// Mint a fresh embedded sign URL for the client-facing signing page. Sign URLs
// are short-lived, so they are generated on demand rather than persisted.
const getEmbeddedSignSession = async (signingToken: string) => {
  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(eq(feeAgreements.signingToken, signingToken))
    .limit(1);

  if (!agreement) throw new NotFoundError("Signing session not found");
  if (agreement.status === "signed")
    throw new ConflictError("This agreement has already been signed");
  if (agreement.status === "voided")
    throw new BadRequestError(
      "This agreement is no longer available for signing",
    );
  if (!agreement.signerSignatureId)
    throw new BadRequestError(
      "This agreement has not been sent for signature yet",
    );

  const provider = getESignatureProvider();
  const { signUrl, expiresAt } = await provider.getEmbeddedSignUrl(
    agreement.signerSignatureId,
  );
  return { signUrl, clientId: env.DROPBOX_SIGN_CLIENT_ID ?? null, expiresAt };
};

// ─── Dropbox Sign Webhook ───────────────────────────────────────────────────

type DropboxSignEvent = {
  event?: {
    event_time?: string;
    event_type?: string;
    event_hash?: string;
  };
  signature_request?: {
    signature_request_id?: string;
  };
};

// Authoritative completion signal. The controller parses the multipart `json`
// field and passes the decoded event here. Must be idempotent — Dropbox Sign
// retries and may deliver duplicates.
const handleDropboxSignWebhook = async (payload: DropboxSignEvent) => {
  const event = payload?.event;
  if (!event?.event_time || !event?.event_type || !event?.event_hash) {
    throw new BadRequestError("Malformed Dropbox Sign event");
  }

  const provider = getESignatureProvider();
  if (
    !provider.verifyWebhook(
      event.event_time,
      event.event_type,
      event.event_hash,
    )
  ) {
    throw new AuthorizationError("Invalid Dropbox Sign event signature");
  }

  // Dashboard "test" callback: acknowledge without side effects.
  if (event.event_type === "callback_test") {
    return { processed: false, test: true };
  }

  const signatureRequestId = payload.signature_request?.signature_request_id;
  if (!signatureRequestId) {
    return { ignored: true, reason: "No signature_request in event" };
  }

  const [agreement] = await db
    .select()
    .from(feeAgreements)
    .where(eq(feeAgreements.envelopeId, signatureRequestId))
    .limit(1);
  if (!agreement) {
    return { ignored: true, reason: "No agreement for signature request" };
  }

  const now = new Date();
  // Record the latest provider event for observability.
  await db
    .update(feeAgreements)
    .set({
      providerStatus: event.event_type,
      lastWebhookEventAt: now,
      updatedAt: now,
    })
    .where(eq(feeAgreements.id, agreement.id));

  if (event.event_type === "signature_request_all_signed") {
    if (agreement.status === "signed") {
      return { ignored: true, reason: "Already signed" };
    }

    // Archive the completed, signed PDF. Non-fatal on failure — the signature
    // is still valid and can be re-fetched later.
    let signedKey: string | null = null;
    try {
      const signedPdf = await provider.downloadSignedPdf(signatureRequestId);
      signedKey = `fee-agreements/${agreement.organizationId}/${agreement.id}/signed.pdf`;
      await storageService.upload({
        key: signedKey,
        body: signedPdf,
        contentType: "application/pdf",
      });
    } catch (err) {
      console.error("Failed to archive signed fee-agreement PDF", err);
    }

    await db
      .update(feeAgreements)
      .set({
        status: "signed",
        clientSignedAt: now,
        ...(signedKey ? { signedDocumentUrl: signedKey } : {}),
        updatedAt: now,
      })
      .where(eq(feeAgreements.id, agreement.id));

    // The client signed through the provider, so there is no staff actor here.
    // Leave it null rather than attributing the signature to whoever sent it.
    await logLeadEvent({
      organizationId: agreement.organizationId,
      leadId: agreement.leadId,
      type: "fee_agreement_signed",
      actorId: null,
      metadata: { agreementId: agreement.id, via: "e_signature" },
    });

    // Auto-advance the lead to case_opening only when the payment gate is also
    // satisfied; otherwise it stays in the consultation stage until staff mark
    // the payment received.
    if (feeAgreementPaymentSatisfied(agreement.details)) {
      await advanceLeadToCaseOpening(
        agreement.leadId,
        agreement.organizationId,
        now,
        null,
      );
    }

    return { processed: true, agreementId: agreement.id };
  }

  if (
    event.event_type === "signature_request_declined" ||
    event.event_type === "signature_request_canceled"
  ) {
    if (agreement.status !== "signed") {
      await db
        .update(feeAgreements)
        .set({ status: "voided", updatedAt: now })
        .where(eq(feeAgreements.id, agreement.id));

      await logLeadEvent({
        organizationId: agreement.organizationId,
        leadId: agreement.leadId,
        type: "fee_agreement_voided",
        actorId: null,
        metadata: { agreementId: agreement.id, reason: event.event_type },
      });
    }
    return { processed: true, agreementId: agreement.id, voided: true };
  }

  return { processed: false, eventType: event.event_type };
};

// ─── Case Opening ──────────────────────────────────────────────────────────────

const getEligibleTeamsForLead = async (
  leadId: string,
  organizationId: string,
) => {
  const [leadCaseType] = await db
    .select({ caseTypeId: leads.caseTypeId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!leadCaseType?.caseTypeId) return [];

  const leadStaff = aliasedTable(staff, "leadStaff");

  const rows = await db
    .select({
      id: team.id,
      name: team.name,
      leadName: sql<string | null>`
        CASE WHEN ${leadStaff.id} IS NOT NULL
          THEN ${leadStaff.firstName} || ' ' || ${leadStaff.lastName}
        END
      `,
      memberCount: sql<number>`
        COALESCE(
          (SELECT COUNT(*) FROM ${teamMember} WHERE ${teamMember.teamId} = ${team.id}),
          0
        )::int
      `,
    })
    .from(teamPracticeAreaCaseTypes)
    .innerJoin(team, eq(team.id, teamPracticeAreaCaseTypes.teamId))
    .leftJoin(leadStaff, sql`${leadStaff.id}::text = ${team.leadId}`)
    .where(
      and(
        eq(teamPracticeAreaCaseTypes.caseTypeId, leadCaseType.caseTypeId),
        eq(team.organizationId, organizationId),
      ),
    );

  return rows;
};

const openCase = async (
  leadId: string,
  organizationId: string,
  data: {
    assignedTeamId?: string;
  },
  creatorStaffId: string,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.convertedCaseId)
    throw new ConflictError("This lead has already been converted to a case");

  // Validate prerequisites
  if (lead.conflictCheckId) {
    const [cc] = await db
      .select()
      .from(conflictChecks)
      .where(eq(conflictChecks.id, lead.conflictCheckId))
      .limit(1);

    if (cc && cc.status === "conflict_found" && !cc.supervisorOverrideById) {
      throw new ConflictError(
        "Conflict check must be resolved before opening a case",
      );
    }
  }

  if (lead.feeAgreementId) {
    const [fa] = await db
      .select()
      .from(feeAgreements)
      .where(eq(feeAgreements.id, lead.feeAgreementId))
      .limit(1);

    if (!fa || fa.status !== "signed") {
      throw new ConflictError(
        "Fee agreement must be signed before opening a case",
      );
    }
    if (!feeAgreementPaymentSatisfied(fa.details)) {
      throw new ConflictError("Payment must be received before opening a case");
    }
  }

  return withTransaction(db, async () => {
    // 1. Create client entity
    const leadName = `${lead.firstName} ${lead.lastName}`;
    const [client] = await db
      .insert(clients)
      .values({
        organizationId,
        entityType: lead.entityType as any,
        firstName: lead.firstName,
        lastName: lead.lastName,
        displayName: leadName,
        email: lead.email,
        phone: lead.phone ?? undefined,
        status: "active",
      })
      .returning();

    // 2. Create primary contact from lead data
    await db.insert(clientContacts).values({
      organizationId,
      clientId: client.id,
      type: "primary_client",
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone ?? undefined,
    });

    // 3. Resolve practice area and case type from junction tables
    const [leadPracticeArea] = await db
      .select({
        practiceAreaId: leads.practiceAreaId,
        caseTypeId: leads.caseTypeId,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    const leadCaseType = leadPracticeArea;

    const resolvedPracticeAreaId = leadPracticeArea?.practiceAreaId;
    const resolvedCaseTypeId = leadCaseType?.caseTypeId;

    if (!resolvedPracticeAreaId || !resolvedCaseTypeId) {
      throw new BadRequestError(
        "Lead must have a practice area and case type before opening a case",
      );
    }

    const [practiceArea] = await db
      .select({ id: practiceAreas.id })
      .from(practiceAreas)
      .where(eq(practiceAreas.id, resolvedPracticeAreaId))
      .limit(1);

    const [caseType] = await db
      .select()
      .from(practiceAreaCaseTypes)
      .where(eq(practiceAreaCaseTypes.id, resolvedCaseTypeId))
      .limit(1);

    if (!caseType) throw new NotFoundError("Case type not found");

    const caseNumber = await generateCaseNumber(
      organizationId,
      resolvedPracticeAreaId,
      caseType.code,
    );

    const [newCase] = await db
      .insert(cases)
      .values({
        organizationId,
        caseNumber,
        clientId: client.id,
        leadId,
        practiceAreaId: resolvedPracticeAreaId,
        caseTypeId: resolvedCaseTypeId,
        priority: "medium",
        assignedTeamId: data.assignedTeamId ?? null,
        filingDate: new Date().toISOString().split("T")[0],
        description: lead.situationSummary ?? `Case for ${leadName}`,
        openedById: creatorStaffId,
      })
      .returning();

    // 4. Instantiate workflow steps from template (proper hydration)
    const { workflowSteps } = await hydrateCaseWorkflow({
      organizationId,
      caseId: newCase.id,
      practiceAreaId: resolvedPracticeAreaId,
    });

    // 5. Update lead with conversion data
    const now = new Date();
    await db
      .update(leads)
      .set({
        clientId: client.id,
        convertedCaseId: newCase.id,
        convertedAt: now,
        pipelineStage: "case_opening",
        status: "reviewed",
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));

    // Money raised during intake was billed to the lead, because a client row
    // did not exist yet — this is the moment one does. Repointing here, inside
    // the same transaction that creates the client, is what keeps the invoice
    // list showing one party per invoice rather than a lead who has since
    // become a client. Same reasoning as the questionnaire and document
    // relinking below.
    //
    // `client_id IS NULL` rather than a blanket update: an invoice already
    // pointing at a client is not this lead's to move, and the check constraint
    // requires exactly one of the two.
    await db
      .update(invoices)
      .set({ clientId: client.id, leadId: null, updatedAt: now })
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.leadId, leadId),
          isNull(invoices.clientId),
        ),
      );

    await logStageChange({
      organizationId,
      leadId,
      from: lead.pipelineStage,
      to: "case_opening",
      actorId: creatorStaffId,
    });

    await logLeadEvent({
      organizationId,
      leadId,
      type: "case_opened",
      actorId: creatorStaffId,
      metadata: {
        caseId: newCase.id,
        caseNumber: newCase.caseNumber,
        clientId: client.id,
      },
    });

    // 6. Link questionnaire responses to the new client and case
    if (lead.questionnaireSendId) {
      await db
        .update(questionnaireSends)
        .set({ clientId: client.id, caseId: newCase.id, updatedAt: now })
        .where(eq(questionnaireSends.id, lead.questionnaireSendId));

      await db
        .update(questionnaireResponses)
        .set({ clientId: client.id, caseId: newCase.id, updatedAt: now })
        .where(
          eq(
            questionnaireResponses.questionnaireSendId,
            lead.questionnaireSendId,
          ),
        );
    }

    // 7. Carry the lead's documents onto the case.
    //
    // These are RE-LINKED, not copied. Questionnaire uploads are already
    // first-class `documents` rows, so adding a case link preserves document
    // identity — and with it the checksum, the cached AI analysis, and any
    // findings or resolved issues attached to the document during intake.
    // Copying would mint a second identity for the same bytes and strand all
    // of that at exactly the point the firm cares most.
    await relinkLeadDocumentsToCase(leadId, newCase.id);

    // Requirements MOVE from the lead to the case (single row, identity and
    // satisfaction preserved) rather than being duplicated.
    await db
      .update(scenarioDocumentRequirements)
      .set({ leadId: null, caseId: newCase.id, updatedAt: new Date() })
      .where(eq(scenarioDocumentRequirements.leadId, leadId));

    // Materialize the case type's requirement templates onto the new case
    // (idempotent; skips any already present from the lead move).
    if (newCase.caseTypeId) {
      await materializeCaseTypeRequirements({
        organizationId,
        caseId: newCase.id,
        caseTypeId: newCase.caseTypeId,
      });
    }

    /**
     * TODO: Notify assigned team lead of new case. This is commented out for now because the assigned team may not be set at the time of case opening, and we don't want to send notifications to the wrong person. We will revisit this logic once we have a clearer understanding of how team assignments will work in the future.
     */
    // 7. Notify
    // const assignedStaffId = data.assignedTeamId ?? lead.respondentId;
    //     if (assignedStaffId) {
    //       const [assignedStaff] = await db
    //         .select({ email: user.email, firstName: staff.firstName })
    //         .from(staff)
    //         .leftJoin(user, eq(staff.userId, user.id))
    //         .where(eq(staff.id, assignedStaffId))
    //         .limit(1);
    //
    //       if (assignedStaff) {
    //         emailService
    //           .sendEmail({
    //             to: assignedStaff.email!,
    //             subject: `New case opened: ${newCase.caseNumber}`,
    //             html: `<p>Hi ${assignedStaff.firstName},</p>
    //               <p>A new case has been opened for ${leadName}.</p>
    //               <p><strong>Case Number:</strong> ${newCase.caseNumber}</p>
    //               <p><strong>Case Type:</strong> ${caseType.name}</p>`,
    //           })
    //           .catch(console.error);
    //       }
    //     }

    emailService
      .sendEmail({
        to: lead.email,
        subject: "Your case has been opened",
        html: `<p>Dear ${leadName},</p>
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

const getCaseWorkflowSteps = async (caseId: string, organizationId: string) => {
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

const updateCaseWorkflowStep = async (
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

  const [caseRow] = await db
    .select({ leadId: cases.leadId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (caseRow?.leadId) {
    await logLeadEvent({
      organizationId,
      leadId: caseRow.leadId,
      type: "case_workflow_step_updated",
      metadata: { caseId, stepId, changes: data },
    });
  }

  return updated;
};

// ─── Adverse Parties ──────────────────────────────────────────────────────────

const getAdverseParties = async (caseId: string, organizationId: string) => {
  return db
    .select()
    .from(adverseParties)
    .where(
      and(
        eq(adverseParties.caseId, caseId),
        eq(adverseParties.organizationId, organizationId),
      ),
    );
};

const addAdverseParty = async (
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

  const [caseRow] = await db
    .select({ leadId: cases.leadId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (caseRow?.leadId) {
    await logLeadEvent({
      organizationId,
      leadId: caseRow.leadId,
      type: "adverse_party_added",
      metadata: {
        caseId,
        partyId: created.id,
        name: data.name,
        relationship: data.relationship,
      },
    });
  }

  return created;
};

const updateAdverseParty = async (
  caseId: string,
  partyId: string,
  organizationId: string,
  data: Partial<{
    name: string;
    email: string;
    entityType: string;
    relationship: string;
    notes: string;
  }>,
) => {
  const [updated] = await db
    .update(adverseParties)
    .set({
      ...data,
      entityType: data.entityType as any,
      relationship: data.relationship as any,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(adverseParties.id, partyId),
        eq(adverseParties.caseId, caseId),
        eq(adverseParties.organizationId, organizationId),
      ),
    )
    .returning();

  if (!updated) throw new NotFoundError("Adverse party not found");

  const [caseRow] = await db
    .select({ leadId: cases.leadId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (caseRow?.leadId) {
    await logLeadEvent({
      organizationId,
      leadId: caseRow.leadId,
      type: "adverse_party_updated",
      metadata: { caseId, partyId, changes: data },
    });
  }

  return updated;
};

const deleteAdverseParty = async (
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

  const [caseRow] = await db
    .select({ leadId: cases.leadId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (caseRow?.leadId) {
    await logLeadEvent({
      organizationId,
      leadId: caseRow.leadId,
      type: "adverse_party_deleted",
      metadata: { caseId, partyId },
    });
  }
};

// ─── Unified Timeline ──────────────────────────────────────────────────────
// Merges lead_events + lead_timeline_events into a single sorted timeline,
// matching the cases pattern (case_timeline_events + step_action_logs).

const EVENT_TITLE_MAP: Record<string, string> = {
  lead_received: "Lead received",
  lead_updated: "Lead updated",
  lead_viewed: "Lead viewed",
  stage_changed: "Stage changed",
  lead_assigned: "Lead assigned",
  lead_archived: "Lead archived",
  lead_restored: "Lead restored",
  note_added: "Note added",
  note_updated: "Note updated",
  note_deleted: "Note deleted",
  note_pinned: "Note pinned",
  note_unpinned: "Note unpinned",
  conflict_check_run: "Conflict check run",
  conflict_check_approved: "Conflict check approved",
  conflict_check_declined: "Conflict check declined",
  conflict_overridden: "Conflict overridden",
  questionnaire_sent: "Questionnaire sent",
  questionnaire_opened: "Questionnaire opened",
  questionnaire_draft_saved: "Questionnaire draft saved",
  questionnaire_response_received: "Questionnaire response received",
  questionnaire_file_uploaded: "Questionnaire file uploaded",
  consultation_scheduled: "Consultation scheduled",
  consultation_rescheduled: "Consultation rescheduled",
  consultation_cancelled: "Consultation cancelled",
  consultation_completed: "Consultation completed",
  consultation_booking_opened: "Consultation booking opened",
  consultation_slot_selected: "Consultation slot selected",
  fee_agreement_generated: "Fee agreement generated",
  fee_agreement_sent: "Fee agreement sent",
  fee_agreement_signed: "Fee agreement signed",
  fee_agreement_discarded: "Fee agreement discarded",
  fee_agreement_voided: "Fee agreement voided",
  payment_received: "Payment received",
  case_opened: "Case opened",
  case_workflow_step_updated: "Case workflow step updated",
  nudge_sent: "Reminder sent",
  pipeline_initialized: "Pipeline initialized",
  task_created: "Task created",
  task_updated: "Task updated",
  task_assigned: "Task assigned",
  task_completed: "Task completed",
  task_status_changed: "Task status changed",
  task_deleted: "Task deleted",
  task_submitted_for_review: "Task submitted for review",
  task_approved: "Task approved",
  task_rejected: "Task rejected",
  document_linked: "Document linked",
  document_unlinked: "Document unlinked",
  adverse_party_added: "Adverse party added",
  adverse_party_updated: "Adverse party updated",
  adverse_party_deleted: "Adverse party deleted",
  missing_documents_requested: "Missing documents requested",
  reminder_sent: "Reminder sent",
};

const getLeadTimeline = async (
  leadId: string,
  organizationId: string,
  page = 1,
  limit = 20,
) => {
  const [events, timelineEvents] = await Promise.all([
    db
      .select({
        id: leadEvents.id,
        eventType: leadEvents.type,
        title: leadEvents.type,
        description: sql<string | null>`null`,
        metadata: leadEvents.metadata,
        ipAddress: leadEvents.ipAddress,
        createdById: leadEvents.actorId,
        createdAt: leadEvents.createdAt,
      })
      .from(leadEvents)
      .where(
        and(
          eq(leadEvents.leadId, leadId),
          eq(leadEvents.organizationId, organizationId),
        ),
      ),
    db
      .select({
        id: leadTimelineEvents.id,
        eventType: leadTimelineEvents.eventType,
        title: leadTimelineEvents.title,
        description: leadTimelineEvents.description,
        metadata: leadTimelineEvents.metadata,
        createdById: leadTimelineEvents.createdById,
        createdAt: leadTimelineEvents.createdAt,
      })
      .from(leadTimelineEvents)
      .innerJoin(leads, eq(leadTimelineEvents.leadId, leads.id))
      .where(
        and(
          eq(leadTimelineEvents.leadId, leadId),
          eq(leads.organizationId, organizationId),
        ),
      ),
  ]);

  // Resolve staff names for both sources
  const allActorIds = [
    ...new Set([
      ...(events.map((e) => e.createdById).filter(Boolean) as string[]),
      ...(timelineEvents.map((e) => e.createdById).filter(Boolean) as string[]),
    ]),
  ];

  let staffMap: Record<string, string> = {};
  if (allActorIds.length > 0) {
    const staffRows = await db
      .select({
        id: staff.id,
        name: sql<string>`concat(${staff.firstName}, ' ', ${staff.lastName})`,
      })
      .from(staff)
      .where(
        and(
          inArray(staff.id, allActorIds),
          eq(staff.organizationId, organizationId),
        ),
      );
    staffMap = Object.fromEntries(staffRows.map((r) => [r.id, r.name]));
  }

  // Normalize and merge
  const merged = [
    ...events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      title: EVENT_TITLE_MAP[e.eventType] ?? e.eventType,
      description: e.description,
      metadata: e.metadata as Record<string, unknown> | null,
      ipAddress: e.ipAddress,
      createdBy: e.createdById
        ? { id: e.createdById, name: staffMap[e.createdById] ?? "Unknown" }
        : null,
      createdAt: e.createdAt,
    })),
    ...timelineEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      title: e.title,
      description: e.description,
      metadata: e.metadata as Record<string, unknown> | null,
      ipAddress: null as string | null,
      createdBy: e.createdById
        ? { id: e.createdById, name: staffMap[e.createdById] ?? "Unknown" }
        : null,
      createdAt: e.createdAt,
    })),
  ];

  merged.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const total = merged.length;
  const offset = (page - 1) * limit;
  const data = merged.slice(offset, offset + limit);

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

// ─── Audit Log ─────────────────────────────────────────────────────────────
// Read-only view of the lead_events audit trail, formatted for the audit log
// tab. Uses UPPER_SNAKE_CASE event types to match the cases audit log pattern.

const AUDIT_EVENT_TYPE_MAP: Record<string, string> = {
  lead_received: "LEAD_RECEIVED",
  lead_updated: "LEAD_UPDATED",
  lead_viewed: "LEAD_VIEWED",
  stage_changed: "STAGE_CHANGED",
  lead_assigned: "LEAD_ASSIGNED",
  lead_archived: "LEAD_ARCHIVED",
  lead_restored: "LEAD_RESTORED",
  note_added: "NOTE_ADDED",
  note_updated: "NOTE_UPDATED",
  note_deleted: "NOTE_DELETED",
  note_pinned: "NOTE_PINNED",
  note_unpinned: "NOTE_UNPINNED",
  conflict_check_run: "CONFLICT_CHECK_RUN",
  conflict_check_approved: "CONFLICT_CHECK_APPROVED",
  conflict_check_declined: "CONFLICT_CHECK_DECLINED",
  conflict_overridden: "CONFLICT_OVERRIDDEN",
  questionnaire_sent: "QUESTIONNAIRE_SENT",
  questionnaire_opened: "QUESTIONNAIRE_OPENED",
  questionnaire_draft_saved: "QUESTIONNAIRE_DRAFT_SAVED",
  questionnaire_response_received: "QUESTIONNAIRE_RESPONSE_RECEIVED",
  questionnaire_file_uploaded: "QUESTIONNAIRE_FILE_UPLOADED",
  consultation_scheduled: "CONSULTATION_SCHEDULED",
  consultation_rescheduled: "CONSULTATION_RESCHEDULED",
  consultation_cancelled: "CONSULTATION_CANCELLED",
  consultation_completed: "CONSULTATION_COMPLETED",
  consultation_booking_opened: "CONSULTATION_BOOKING_OPENED",
  consultation_slot_selected: "CONSULTATION_SLOT_SELECTED",
  fee_agreement_generated: "FEE_AGREEMENT_GENERATED",
  fee_agreement_sent: "FEE_AGREEMENT_SENT",
  fee_agreement_signed: "FEE_AGREEMENT_SIGNED",
  fee_agreement_discarded: "FEE_AGREEMENT_DISCARDED",
  fee_agreement_voided: "FEE_AGREEMENT_VOIDED",
  payment_received: "PAYMENT_RECEIVED",
  case_opened: "CASE_OPENED",
  case_workflow_step_updated: "CASE_WORKFLOW_STEP_UPDATED",
  nudge_sent: "NUDGE_SENT",
  pipeline_initialized: "PIPELINE_INITIALIZED",
  task_created: "TASK_CREATED",
  task_updated: "TASK_UPDATED",
  task_assigned: "TASK_ASSIGNED",
  task_completed: "TASK_COMPLETED",
  task_status_changed: "TASK_STATUS_CHANGED",
  task_deleted: "TASK_DELETED",
  task_submitted_for_review: "TASK_SUBMITTED_FOR_REVIEW",
  task_approved: "TASK_APPROVED",
  task_rejected: "TASK_REJECTED",
  document_linked: "DOCUMENT_LINKED",
  document_unlinked: "DOCUMENT_UNLINKED",
  adverse_party_added: "ADVERSE_PARTY_ADDED",
  adverse_party_updated: "ADVERSE_PARTY_UPDATED",
  adverse_party_deleted: "ADVERSE_PARTY_DELETED",
  missing_documents_requested: "MISSING_DOCUMENTS_REQUESTED",
  reminder_sent: "REMINDER_SENT",
};

const getLeadAuditLog = async (
  leadId: string,
  organizationId: string,
  page = 1,
  limit = 20,
) => {
  const rows = await db
    .select({
      id: leadEvents.id,
      type: leadEvents.type,
      actorId: leadEvents.actorId,
      actorNameSnapshot: leadEvents.actorNameSnapshot,
      firstName: staff.firstName,
      lastName: staff.lastName,
      metadata: leadEvents.metadata,
      ipAddress: leadEvents.ipAddress,
      createdAt: leadEvents.createdAt,
    })
    .from(leadEvents)
    .leftJoin(staff, eq(leadEvents.actorId, staff.id))
    .where(
      and(
        eq(leadEvents.leadId, leadId),
        eq(leadEvents.organizationId, organizationId),
      ),
    )
    .orderBy(desc(leadEvents.createdAt));

  const total = rows.length;
  const offset = (page - 1) * limit;
  const pageRows = rows.slice(offset, offset + limit);

  const data = pageRows.map((r) => ({
    id: r.id,
    eventType: AUDIT_EVENT_TYPE_MAP[r.type] ?? r.type.toUpperCase(),
    title: EVENT_TITLE_MAP[r.type] ?? r.type,
    description: null as string | null,
    metadata: r.metadata as Record<string, unknown> | null,
    ipAddress: r.ipAddress,
    performedBy: r.actorId
      ? {
          id: r.actorId,
          name: r.firstName
            ? `${r.firstName} ${r.lastName}`.trim()
            : (r.actorNameSnapshot ?? "Unknown"),
        }
      : null,
    createdAt: r.createdAt,
  }));

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

export class LeadsService {
  createLead = createLead;
  getAllLeads = getAllLeads;
  getLeadById = getLeadById;
  updateLead = updateLead;
  updateLeadStatus = updateLeadStatus;
  getLeadStageCounts = getLeadStageCounts;
  getLeadMetrics = getLeadMetrics;
  getLeadActivity = getLeadActivity;
  getLeadNotes = getLeadNotes;
  addLeadNote = addLeadNote;
  updateLeadNote = updateLeadNote;
  deleteLeadNote = deleteLeadNote;
  bulkDeleteNotes = bulkDeleteNotes;
  bulkPinNotes = bulkPinNotes;
  toggleNotePin = toggleNotePin;
  archiveLead = archiveLead;
  restoreLead = restoreLead;
  advanceLeadStage = advanceLeadStage;
  runConflictCheck = runConflictCheck;
  getConflictCheck = getConflictCheck;
  resolveConflictCheck = resolveConflictCheck;
  sendQuestionnaire = sendQuestionnaire;
  getLeadQuestionnaire = getLeadQuestionnaire;
  initiateConsultation = initiateConsultation;
  getConsultation = getConsultation;
  getConsultations = getConsultations;
  updateConsultation = updateConsultation;
  cancelConsultation = cancelConsultation;
  getConsultationBooking = getConsultationBooking;
  getLeadTimezone = getLeadTimezone;
  payConsultationFee = payConsultationFee;
  selectConsultationSlot = selectConsultationSlot;
  generateFeeAgreement = generateFeeAgreement;
  discardDraftFeeAgreement = discardDraftFeeAgreement;
  getFeeAgreementPreview = getFeeAgreementPreview;
  sendFeeAgreement = sendFeeAgreement;
  markFeeAgreementReceived = markFeeAgreementReceived;
  markFeeAgreementPaymentReceived = markFeeAgreementPaymentReceived;
  getFeeAgreement = getFeeAgreement;
  nudgeClient = nudgeClient;
  getEmbeddedSignSession = getEmbeddedSignSession;
  handleDropboxSignWebhook = handleDropboxSignWebhook;
  openCase = openCase;
  getEligibleTeamsForLead = getEligibleTeamsForLead;
  getCaseWorkflowSteps = getCaseWorkflowSteps;
  updateCaseWorkflowStep = updateCaseWorkflowStep;
  getAdverseParties = getAdverseParties;
  addAdverseParty = addAdverseParty;
  updateAdverseParty = updateAdverseParty;
  deleteAdverseParty = deleteAdverseParty;
  getLeadTimeline = getLeadTimeline;
  getLeadAuditLog = getLeadAuditLog;
  getLeadLayout = getLeadLayout;
}
