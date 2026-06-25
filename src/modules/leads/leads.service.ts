import { createHash, randomBytes, randomUUID } from "crypto";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  ne,
  or,
} from "drizzle-orm";
import {
  cancelQuestionnaireReminder,
  scheduleQuestionnaireReminder,
} from "../../queue/queues";
import { emailService } from "../../utils/email/email.service";
import { db } from "../../db/client";
import { adverseParties } from "../../db/schema/adverse-parties";
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
import {
  caseWorkflowSteps,
  workflowTemplates,
  workflowTemplateSteps,
} from "../../db/schema/workflow";
import {
  AuthorizationError,
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
import { user } from "../../db/schema/auth-schema";
import { env } from "../../config/env";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const generateAccessToken = () => randomBytes(32).toString("base64url");

const normalizeName = (name: string) => name.trim().toLowerCase();

// Entity/stopwords that should never constitute a match on their own, so an
// opponent like "Bianchi" matches the client "Bianchi Family Trust" without
// every "Group" or "Trust" colliding with one another.
const ENTITY_STOPWORDS = new Set([
  "family", "trust", "estate", "llc", "l.l.c", "inc", "incorporated", "corp",
  "corporation", "co", "company", "group", "holdings", "ltd", "limited", "lp",
  "llp", "plc", "pllc", "the", "and", "of", "&",
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

const enrichMatchesWithCaseContext = async (storedMatches: StoredMatch[]) => {
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
        caseType: cases.caseType,
        status: cases.status,
        practiceArea: practiceAreas.name,
        clientId: cases.clientId,
        clientName: clients.displayName,
      })
      .from(cases)
      .leftJoin(practiceAreas, eq(practiceAreas.id, cases.practiceAreaId))
      .leftJoin(clients, eq(clients.id, cases.clientId))
      .where(inArray(cases.id, allCaseIds));

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
      .where(inArray(adverseParties.id, adverseMatchIds));

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
    intakeAdversePartyName?: string;
    intakeAdversePartyEmail?: string;
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
      intakeAdversePartyName: data.intakeAdversePartyName,
      intakeAdversePartyEmail: data.intakeAdversePartyEmail,
    })
    .returning();

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
  if (filters.practiceAreaId)
    conditions.push(eq(leads.practiceAreaId, filters.practiceAreaId));
  if (filters.source) conditions.push(eq(leads.source, filters.source as any));
  if (filters.search) {
    const q = `%${filters.search}%`;
    conditions.push(or(ilike(leads.name, q), ilike(leads.email, q))!);
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
          | { matches: StoredMatch[]; status: string }
          | undefined;
        if (!conflict) return r;
        const { matches } = conflict;
        if (!matches || matches.length === 0) return r;
        const conflictMatches = await enrichMatchesWithCaseContext(matches);
        return { ...r, conflictMatches, conflictCheckStatus: conflict.status };
      }),
    );

    return enriched;
  };

  if (filters.all) {
    const rows = await db
      .select({
        ...getTableColumns(leads),
        caseTypeName: practiceAreaCaseTypes.name,
      })
      .from(leads)
      .leftJoin(
        practiceAreaCaseTypes,
        eq(leads.caseTypeId, practiceAreaCaseTypes.id),
      )
      .where(where)
      .orderBy(desc(leads.receivedAt));
    return attachConflictMatches(rows);
  }

  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = getPaginationOffset({ page, limit });

  const [countRow] = await db
    .select({ total: count() })
    .from(leads)
    .where(where);

  const rows = await db
    .select({
      ...getTableColumns(leads),
      caseTypeName: practiceAreaCaseTypes.name,
    })
    .from(leads)
    .leftJoin(
      practiceAreaCaseTypes,
      eq(leads.caseTypeId, practiceAreaCaseTypes.id),
    )
    .where(where)
    .orderBy(desc(leads.receivedAt))
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
      caseTypeName: practiceAreaCaseTypes.name,
    })
    .from(leads)
    .leftJoin(
      practiceAreaCaseTypes,
      eq(leads.caseTypeId, practiceAreaCaseTypes.id),
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

  return {
    ...lead,
    conflictCheck,
    questionnaireSend,
    consultation,
    feeAgreement,
  };
};

const updateLead = async (
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
    intakeAdversePartyName: string;
    intakeAdversePartyEmail: string;
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

const updateLeadStatus = async (
  id: string,
  organizationId: string,
  status: "archived" | "reviewed",
) => {
  const [updated] = await db
    .update(leads)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.organizationId, organizationId)))
    .returning();

  if (!updated) throw new NotFoundError("Lead not found");
  return updated;
};

const getLeadStageCounts = async (organizationId: string) => {
  const rows = await db
    .select({ stage: leads.pipelineStage, total: count() })
    .from(leads)
    // Exclude declined leads so stage badges match the default lists
    .where(and(eq(leads.organizationId, organizationId), ne(leads.status, "declined")))
    .groupBy(leads.pipelineStage);

  const result: Record<string, number> = {
    lead_inbox: 0,
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
  "lead_inbox",
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
] as const;

const advanceLeadStage = async (
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
  const normalizedName = normalizeName(lead.name);
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
      .where(eq(leads.id, leadId));
  }

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
          .where(eq(leads.id, leadId));
      }
    } else {
      // needs_review / conflict_found are held at conflict_check.
      if (currentIdx < STAGE_ORDER.indexOf("conflict_check")) {
        await db
          .update(leads)
          .set({ pipelineStage: "conflict_check", updatedAt: now })
          .where(eq(leads.id, leadId));
      }
    }
  }

  const enrichedMatches = await enrichMatchesWithCaseContext(matches);
  return { ...checkRecord, matches: enrichedMatches };
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
  const enrichedMatches = await enrichMatchesWithCaseContext(storedMatches);
  return { ...cc, matches: enrichedMatches };
};

// Neutral, non-accusatory notice. NEVER discloses the conflict, matched party,
// or any specifics — see plan A7.
const buildDeclineEmail = (lead: { name: string; email: string }) => ({
  to: lead.email,
  subject: "Update on your inquiry",
  html: `
    <p>Dear ${lead.name},</p>
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
    .where(eq(staff.id, staffId))
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

  const updated = await db.transaction(async (tx) => {
    if (data.action === "approve") {
      const [u] = await tx
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

      await tx
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
      return u;
    }

    // decline — terminate the lead for conflict
    const [u] = await tx
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

    await tx
      .update(leads)
      .set({ status: "declined", updatedAt: now }) // stage left as-is (terminal)
      .where(eq(leads.id, leadId));
    return u;
  });

  // Notify the lead after the resolution has committed. Fire-and-forget so an
  // email failure can never roll back the decision.
  if (data.action === "decline")
    emailService.sendEmail(buildDeclineEmail(lead)).catch(console.error);

  const enrichedMatches = await enrichMatchesWithCaseContext(
    (updated.matches ?? []) as StoredMatch[],
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
  if (!lead.caseTypeId)
    throw new BadRequestError(
      "Lead must have a case type assigned before sending a questionnaire",
    );

  const [systemQ] = await db
    .select()
    .from(caseTypeQuestionnaires)
    .where(eq(caseTypeQuestionnaires.caseTypeId, lead.caseTypeId))
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
      lead.caseTypeId,
    );
    let order = Date.now() % 100000;
    for (const q of persistQuestions) {
      await db.insert(firmQuestionnaireQuestions).values({
        organizationId,
        caseTypeId: lead.caseTypeId,
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
        caseTypeId: lead.caseTypeId,
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
      caseTypeId: lead.caseTypeId,
      sentById,
      accessTokenHash: tokenHash(accessToken),
      schemaSnapshot: finalSnapshot as any,
      deliveryChannels,
      language,
      autoReminderDays,
    })
    .returning();

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
  await db
    .update(leads)
    .set({
      questionnaireSendId: send.id,
      pipelineStage: "questionnaire",
      updatedAt: now,
    })
    .where(eq(leads.id, leadId));

  const baseUrl =
    env.FRONTEND_APP_URL ?? "http://localhost:5173";
  const orgSlug = encodeURIComponent(organizationId);
  const clientLink = `${baseUrl}/questionnaire/${orgSlug}/${accessToken}`;

  // Fire-and-forget delivery to lead via the configured channels.
  if (deliveryChannels.includes("email")) {
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
  }
  if (deliveryChannels.includes("sms") && lead.phone) {
    // SMS provider not yet wired — log the intent for now.
    console.log(`[sms-stub] questionnaire link to ${lead.phone}: ${clientLink}`);
  }

  return { send: { ...send, accessToken }, clientLink, sentAt: send.sentAt };
};

/** Cancel a send's pending auto-reminder, if any (e.g. on submission). */
export const cancelSendReminder = async (sendId: string) => {
  const [send] = await db
    .select()
    .from(questionnaireSends)
    .where(eq(questionnaireSends.id, sendId))
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

const createConsultation = async (
  leadId: string,
  organizationId: string,
  data: {
    scheduledAt: Date;
    duration: number;
    mode: "video" | "in_person" | "phone_call";
    leadAttorneyId?: string;
    videoLink?: string;
    preConsultationNotes?: string;
    notifyChannels?: ("email" | "sms")[];
  },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (lead.consultationId)
    throw new ConflictError("Consultation already exists for this lead");

  const notifyChannels = data.notifyChannels?.length
    ? data.notifyChannels
    : ["email"];
  const modeLabel =
    data.mode === "video"
      ? "Video Call"
      : data.mode === "phone_call"
        ? "Phone call"
        : "In Person";

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
    .set({
      consultationId: consultation.id,
      pipelineStage: "consultation",
      updatedAt: now,
    })
    .where(eq(leads.id, leadId));

  // Notify attorney and lead
  const scheduledStr = data.scheduledAt.toLocaleString("en-US", {
    timeZone: "UTC",
  });

  if (data.leadAttorneyId) {
    const [attorney] = await db
      .select({
        email: user.email,
        firstName: staff.firstName,
      })
      .from(staff)
      .leftJoin(user, eq(staff.userId, user.id))
      .where(eq(staff.id, data.leadAttorneyId))
      .limit(1);

    if (attorney) {
      emailService
        .sendEmail({
          to: attorney.email!,
          subject: `New consultation assigned: ${lead.name}`,
          html: `<p>Hi ${attorney.firstName},</p>
            <p>A consultation has been scheduled with <strong>${lead.name}</strong>.</p>
            <p><strong>Date/Time:</strong> ${scheduledStr} UTC</p>
            <p><strong>Mode:</strong> ${modeLabel}</p>
            ${data.videoLink ? `<p><strong>Video Link:</strong> <a href="${data.videoLink}">${data.videoLink}</a></p>` : ""}
            ${data.preConsultationNotes ? `<p><strong>Pre-consultation notes:</strong> ${data.preConsultationNotes}</p>` : ""}`,
        })
        .catch(console.error);
    }
  }

  if (notifyChannels.includes("email")) {
    emailService
      .sendEmail({
        to: lead.email,
        subject: "Your consultation has been scheduled",
        html: `<p>Dear ${lead.name},</p>
          <p>Your consultation has been scheduled for <strong>${scheduledStr} UTC</strong>.</p>
          <p><strong>Mode:</strong> ${modeLabel}</p>
          ${data.videoLink ? `<p><strong>Video Link:</strong> <a href="${data.videoLink}">${data.videoLink}</a></p>` : ""}
          <p>We look forward to speaking with you.</p>`,
      })
      .catch(console.error);
  }

  if (notifyChannels.includes("sms") && lead.phone) {
    console.log(
      `[sms-stub] consultation scheduled for ${lead.phone}: ${scheduledStr} UTC (${modeLabel})`,
    );
  }

  return consultation;
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

  return consultation ?? null;
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
  }>,
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead || !lead.consultationId)
    throw new NotFoundError("No consultation found for this lead");

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

  return updated;
};

// ─── Fee Agreement ─────────────────────────────────────────────────────────────

const generateFeeAgreement = async (
  leadId: string,
  organizationId: string,
  data: {
    agreementType?: string;
    generatedFrom?: "questionnaire_auto" | "manual";
  },
) => {
  const [lead] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))
    .limit(1);

  if (!lead) throw new NotFoundError("Lead not found");
  if (!lead.consultationId)
    throw new BadRequestError(
      "A consultation must be scheduled before generating a fee agreement",
    );
  if (lead.feeAgreementId)
    throw new ConflictError("Fee agreement already exists for this lead");

  const documentContent = `Fee Agreement for ${lead.name} — ${data.agreementType ?? "Standard Retainer"}`;
  const { envelopeId, signingLink } =
    await stubESignatureProvider.createEnvelope(lead.email, documentContent);

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
    .set({
      feeAgreementId: agreement.id,
      pipelineStage: "fee_agreement",
      updatedAt: now,
    })
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
    html: `<p>Dear ${lead.name},</p>
      <p>This is a friendly reminder to sign your fee agreement:</p>
      ${agreement.signingLink ? `<p><a href="${agreement.signingLink}">Sign Agreement</a></p>` : ""}
      <p>Please complete this as soon as possible to proceed with your case.</p>`,
  });

  return { reminderSentAt: now };
};

// ─── eSignature Webhook ────────────────────────────────────────────────────────

const handleESignatureWebhook = async (data: {
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

  if (!agreement)
    return { ignored: true, reason: "No agreement found for envelope" };

  // Idempotent: already processed
  if (agreement.status === "signed")
    return { ignored: true, reason: "Already signed" };

  if (data.status !== "completed") {
    return {
      ignored: true,
      reason: `Envelope status ${data.status} not actionable`,
    };
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

const openCase = async (
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
  }

  if (!lead.practiceAreaId || !lead.caseTypeId) {
    throw new BadRequestError(
      "Lead must have a practice area and case type before opening a case",
    );
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
        assignedStaffId:
          data.assignedStaffId ?? lead.assignedStaffId ?? undefined,
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
        .where(
          eq(
            questionnaireResponses.questionnaireSendId,
            lead.questionnaireSendId,
          ),
        );
    }

    // 7. Notify
    const assignedStaffId = data.assignedStaffId ?? lead.assignedStaffId;
    if (assignedStaffId) {
      const [assignedStaff] = await tx
        .select({ email: user.email, firstName: staff.firstName })
        .from(staff)
        .leftJoin(user, eq(staff.userId, user.id))
        .where(eq(staff.id, assignedStaffId))
        .limit(1);

      if (assignedStaff) {
        emailService
          .sendEmail({
            to: assignedStaff.email!,
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
};

export class LeadsService {
  createLead = createLead;
  getAllLeads = getAllLeads;
  getLeadById = getLeadById;
  updateLead = updateLead;
  updateLeadStatus = updateLeadStatus;
  getLeadStageCounts = getLeadStageCounts;
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
