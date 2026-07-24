import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  AI_MODEL_VERSION,
  effectivePromptVersion,
} from "../ai-scan/vocabulary";
import { aiSystemConfig } from "../../db/schema/ai-system-config";
import { calendarEvents } from "../../db/schema/calendar-events";
import { cases } from "../../db/schema/cases";
import { documentAnalyses } from "../../db/schema/document-analyses";
import {
  caseTypeDocumentRequirements,
  scenarioDocumentRequirements,
} from "../../db/schema/document-requirements";
import {
  documentCaseLinks,
  documents,
  documentVersions,
} from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import type {
  Conflict,
  Deadlines,
  PhotoComparison,
  Requirement,
  RuleContext,
  ScenarioDocument,
  ScenarioType,
} from "./types";

export type ScenarioParams = {
  type: ScenarioType;
  id: string;
  organizationId: string;
};

type CaseDates = {
  clientId: string | null;
  filingDate: Date | null;
  nextCourtDate: Date | null;
  openedAt: Date | null;
};

const loadCaseDates = async (params: ScenarioParams): Promise<CaseDates> => {
  if (params.type !== "case") {
    return { clientId: null, filingDate: null, nextCourtDate: null, openedAt: null };
  }
  const [row] = await db
    .select({
      clientId: cases.clientId,
      filingDate: cases.filingDate,
      nextCourtDate: cases.nextCourtDate,
      openedAt: cases.createdAt,
    })
    .from(cases)
    .where(eq(cases.id, params.id))
    .limit(1);
  return {
    clientId: row?.clientId ?? null,
    filingDate: row?.filingDate ? new Date(row.filingDate) : null,
    nextCourtDate: row?.nextCourtDate ?? null,
    openedAt: row?.openedAt ?? null,
  };
};

const resolveDeadlines = async (
  params: ScenarioParams,
  caseDates: CaseDates,
  now: Date,
): Promise<Deadlines> => {
  // calendar_events are case-only; a lead has none, so its deadline rules stay
  // silent (they are inherently case-stage).
  if (params.type !== "case") {
    return { interviewDate: null, filingDeadline: null, filingSubmitted: false };
  }
  const events = await db
    .select({
      eventType: calendarEvents.eventType,
      status: calendarEvents.status,
      startTime: calendarEvents.startTime,
      customDeadlineDate: calendarEvents.customDeadlineDate,
      filingSubmittedDate: calendarEvents.filingSubmittedDate,
    })
    .from(calendarEvents)
    .where(eq(calendarEvents.caseId, params.id));

  const scheduled = events.filter((e) => e.status === "scheduled");
  const upcoming = (dates: (Date | null)[]) =>
    dates
      .filter((x): x is Date => !!x && x.getTime() >= now.getTime())
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  const interviewDate = upcoming(
    scheduled.filter((e) => e.eventType === "uscis_interview").map((e) => e.startTime),
  );
  const filingDeadline = upcoming(
    scheduled
      .filter((e) => e.eventType === "filing_deadline")
      .map((e) => (e.customDeadlineDate ? new Date(e.customDeadlineDate) : e.startTime)),
  );
  const filingSubmitted =
    !!caseDates.filingDate ||
    events.some((e) => e.eventType === "filing_deadline" && !!e.filingSubmittedDate);

  return { interviewDate, filingDeadline, filingSubmitted };
};

const anchorDate = (
  anchor: string | null,
  deadlines: Deadlines,
  caseDates: CaseDates,
): Date | null => {
  switch (anchor) {
    case "uscis_interview":
      return deadlines.interviewDate;
    case "filing_deadline":
      return deadlines.filingDeadline;
    case "next_court_date":
      return caseDates.nextCourtDate;
    case "case_opened":
      return caseDates.openedAt;
    default:
      return null;
  }
};

const loadRequirements = async (
  params: ScenarioParams,
  deadlines: Deadlines,
  caseDates: CaseDates,
): Promise<Requirement[]> => {
  const scenarioCol =
    params.type === "lead"
      ? scenarioDocumentRequirements.leadId
      : scenarioDocumentRequirements.caseId;

  // Left-join the template so a derived due date (offset from an anchor) can be
  // computed live when there's no manual override — Q3: manual ?? derived.
  const rows = await db
    .select({
      id: scenarioDocumentRequirements.id,
      label: scenarioDocumentRequirements.label,
      documentTypeSlug: scenarioDocumentRequirements.documentTypeSlug,
      isRequired: scenarioDocumentRequirements.isRequired,
      satisfiedByDocumentId: scenarioDocumentRequirements.satisfiedByDocumentId,
      waivedAt: scenarioDocumentRequirements.waivedAt,
      dueDate: scenarioDocumentRequirements.dueDate,
      offsetDays: caseTypeDocumentRequirements.dueDateOffsetDays,
      anchor: caseTypeDocumentRequirements.dueDateAnchor,
    })
    .from(scenarioDocumentRequirements)
    .leftJoin(
      caseTypeDocumentRequirements,
      eq(
        caseTypeDocumentRequirements.id,
        scenarioDocumentRequirements.caseTypeRequirementId,
      ),
    )
    .where(eq(scenarioCol, params.id));

  return rows.map((r) => {
    let effectiveDueDate: Date | null = r.dueDate ? new Date(r.dueDate) : null;
    if (!effectiveDueDate && r.offsetDays != null && r.anchor) {
      const anchor = anchorDate(r.anchor, deadlines, caseDates);
      if (anchor) {
        const derived = new Date(anchor);
        derived.setUTCDate(derived.getUTCDate() - r.offsetDays);
        effectiveDueDate = derived;
      }
    }
    return {
      id: r.id,
      label: r.label,
      documentTypeSlug: r.documentTypeSlug,
      isRequired: r.isRequired,
      satisfiedByDocumentId: r.satisfiedByDocumentId,
      waivedAt: r.waivedAt,
      effectiveDueDate,
    };
  });
};

const loadDocuments = async (
  params: ScenarioParams,
): Promise<ScenarioDocument[]> => {
  const isLead = params.type === "lead";
  const linkDocumentId = isLead
    ? leadDocumentLinks.documentId
    : documentCaseLinks.documentId;
  const linkScenarioCol = isLead ? leadDocumentLinks.leadId : documentCaseLinks.caseId;
  const linkArchivedAt = isLead
    ? leadDocumentLinks.archivedAt
    : documentCaseLinks.archivedAt;
  const linkTable = isLead ? leadDocumentLinks : documentCaseLinks;

  const promptVersion = effectivePromptVersion();

  const rows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      checksum: documentVersions.checksum,
      documentType: documentAnalyses.documentTypeSlug,
      extractedFields: documentAnalyses.extractedFields,
      hasPhoto: documentAnalyses.hasPhoto,
      authenticityVerdict: documentAnalyses.authenticityVerdict,
      authenticityConfidence: documentAnalyses.authenticityConfidence,
    })
    .from(linkTable)
    .innerJoin(documents, eq(documents.id, linkDocumentId))
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    // Only documents whose CURRENT version has a completed analysis under the
    // active prompt/model version contribute facts.
    .innerJoin(
      documentAnalyses,
      and(
        eq(documentAnalyses.checksum, documentVersions.checksum),
        eq(documentAnalyses.promptVersion, promptVersion),
        eq(documentAnalyses.modelVersion, AI_MODEL_VERSION),
        eq(documentAnalyses.status, "complete"),
      ),
    )
    .where(
      and(
        eq(linkScenarioCol, params.id),
        isNull(linkArchivedAt),
        eq(documents.status, "active"),
      ),
    );

  return rows.map((r) => ({
    documentId: r.documentId,
    checksum: r.checksum ?? "",
    title: r.title,
    documentType: r.documentType,
    extractedFields: (r.extractedFields as Record<string, string>) ?? {},
    hasPhoto: r.hasPhoto,
    authenticityVerdict: r.authenticityVerdict,
    authenticityConfidence:
      r.authenticityConfidence != null ? Number(r.authenticityConfidence) : null,
  }));
};

const loadConfig = async (organizationId: string) => {
  const [row] = await db
    .select({
      crossCheckingEnabled: aiSystemConfig.crossCheckingEnabled,
      photoComparisonEnabled: aiSystemConfig.photoComparisonEnabled,
    })
    .from(aiSystemConfig)
    .where(eq(aiSystemConfig.organizationId, organizationId))
    .limit(1);
  return {
    crossCheckingEnabled: row?.crossCheckingEnabled ?? true,
    photoComparisonEnabled: row?.photoComparisonEnabled ?? false,
  };
};

/**
 * Assemble a RuleContext from the scenario's persisted facts, requirements and
 * deadlines, plus the fresh scan result's conflicts/photo comparisons.
 */
export const buildRuleContext = async (
  params: ScenarioParams,
  scan: { conflicts: Conflict[]; photoComparisons: PhotoComparison[] },
): Promise<RuleContext> => {
  const now = new Date();
  const caseDates = await loadCaseDates(params);
  const deadlines = await resolveDeadlines(params, caseDates, now);
  const [documentsList, requirements, config] = await Promise.all([
    loadDocuments(params),
    loadRequirements(params, deadlines, caseDates),
    loadConfig(params.organizationId),
  ]);

  return {
    scenario: {
      type: params.type,
      id: params.id,
      organizationId: params.organizationId,
      clientId: caseDates.clientId,
    },
    now,
    documents: documentsList,
    requirements,
    deadlines,
    conflicts: scan.conflicts,
    photoComparisons: scan.photoComparisons,
    config,
  };
};
