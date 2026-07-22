import { parseDate } from "./normalize";
import { capSeverity, daysUntil, deadlineSeverity } from "./severity";
import type { CandidateIssue, Rule, RuleContext, ScenarioDocument } from "./types";

const SCENARIO_RECORD = "scenario_record";

/** Hard-identity fields — a conflict here is critical; softer fields (names) are high. */
const IDENTITY_FIELDS = new Set([
  "date_of_birth",
  "nationality",
  "passport_number",
  "document_number",
  "national_id_number",
]);

const EXPIRY_KEYS = [
  "expiry_date",
  "expiration_date",
  "date_of_expiry",
  "expires",
  "expiry",
];

/** First non-empty value among candidate keys (exact, then lowercase). */
const pickField = (
  fields: Record<string, string>,
  keys: string[],
): string | null => {
  for (const key of keys) {
    const v = fields[key];
    if (v && v.trim()) return v;
  }
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) lower[k.toLowerCase()] = v;
  for (const key of keys) {
    const v = lower[key];
    if (v && v.trim()) return v;
  }
  return null;
};

const addMonths = (date: Date, months: number): Date => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

const unmetRequirements = (ctx: RuleContext) =>
  ctx.requirements.filter(
    (r) => r.isRequired && !r.satisfiedByDocumentId && !r.waivedAt,
  );

// ── Deterministic rules ──────────────────────────────────────────────────────

const missingRequiredDocument: Rule = {
  issueType: "missing_required_document",
  version: "1",
  evaluate: (ctx) =>
    unmetRequirements(ctx).map((r) => {
      const days = r.effectiveDueDate
        ? daysUntil(r.effectiveDueDate, ctx.now)
        : null;
      return {
        issueType: "missing_required_document",
        source: "rule",
        ruleVersion: "1",
        // Escalates as the due date nears; undated → medium baseline.
        severity: days !== null ? deadlineSeverity(days) : "medium",
        affectedField: `requirement:${r.id}`,
        documentIds: [],
        // Stable while the document is simply missing; due-date changes affect
        // only severity (not in the hash), not identity.
        salientValues: {},
        templateKey: "missing_required_document",
        templateParams: {
          label: r.label,
          dueDate: r.effectiveDueDate?.toISOString() ?? null,
          daysUntil: days,
        },
        facts: { requirementId: r.id, documentTypeSlug: r.documentTypeSlug },
      } satisfies CandidateIssue;
    }),
};

const documentExpiryBeforeDeadline: Rule = {
  issueType: "document_expiry_before_deadline",
  version: "1",
  evaluate: (ctx) => {
    const interview = ctx.deadlines.interviewDate;
    if (!interview) return []; // needs a scheduled interview to compare against
    // USCIS-style rule: validity must extend ~6 months beyond the interview.
    const threshold = addMonths(interview, 6);
    const out: CandidateIssue[] = [];
    for (const doc of ctx.documents) {
      const expiryRaw = pickField(doc.extractedFields, EXPIRY_KEYS);
      if (!expiryRaw) continue;
      const expiry = parseDate(expiryRaw);
      if (!expiry || expiry >= threshold) continue;
      out.push({
        issueType: "document_expiry_before_deadline",
        source: "rule",
        ruleVersion: "1",
        severity: expiry < interview ? "critical" : "high",
        affectedField: "expiry_date",
        documentIds: [doc.documentId],
        salientValues: {
          expiry_date: expiryRaw,
          interview_date: interview.toISOString(),
        },
        templateKey: "document_expiry_before_deadline",
        templateParams: {
          documentTitle: doc.title,
          documentType: doc.documentType,
          expiryDate: expiryRaw,
          interviewDate: interview.toISOString(),
        },
        facts: { checksum: doc.checksum },
      });
    }
    return out;
  },
};

const deadlineApproachingIncomplete: Rule = {
  issueType: "deadline_approaching_incomplete",
  version: "1",
  evaluate: (ctx) => {
    const deadline = ctx.deadlines.filingDeadline;
    if (!deadline) return [];
    const days = daysUntil(deadline, ctx.now);
    if (days > 30) return []; // only once the deadline is in view
    const missing = unmetRequirements(ctx);
    if (missing.length === 0) return []; // complete → nothing to flag
    return [
      {
        issueType: "deadline_approaching_incomplete",
        source: "rule",
        ruleVersion: "1",
        severity: deadlineSeverity(days),
        affectedField: null,
        documentIds: [],
        // Identity is (scenario, this deadline); the missing count drives display,
        // not identity, so uploading one of several missing docs doesn't reopen.
        salientValues: { deadline: deadline.toISOString() },
        templateKey: "deadline_approaching_incomplete",
        templateParams: {
          deadline: deadline.toISOString(),
          missingCount: missing.length,
          missingLabels: missing.map((m) => m.label),
        },
        facts: {},
      },
    ];
  },
};

const filingNotMarkedSubmitted: Rule = {
  issueType: "filing_not_marked_submitted",
  version: "1",
  evaluate: (ctx) => {
    const deadline = ctx.deadlines.filingDeadline;
    if (!deadline || ctx.deadlines.filingSubmitted) return [];
    const days = daysUntil(deadline, ctx.now);
    if (days > 30) return [];
    return [
      {
        issueType: "filing_not_marked_submitted",
        source: "rule",
        ruleVersion: "1",
        severity: deadlineSeverity(days),
        affectedField: null,
        documentIds: [],
        salientValues: { deadline: deadline.toISOString() },
        templateKey: "filing_not_marked_submitted",
        templateParams: { deadline: deadline.toISOString(), daysUntil: days },
        facts: {},
      },
    ];
  },
};

// ── AI-derived rules ─────────────────────────────────────────────────────────

const conflictCandidate = (
  issueType: string,
  field: string,
  values: Record<string, string>,
  documentIds: string[],
  explanation: string,
): CandidateIssue => ({
  issueType,
  source: "ai",
  ruleVersion: "1",
  severity: IDENTITY_FIELDS.has(field) ? "critical" : "high",
  affectedField: field,
  documentIds,
  salientValues: { ...values },
  templateKey: issueType,
  templateParams: { field, values, explanation },
  facts: {},
});

const fieldConflictAcrossDocuments: Rule = {
  issueType: "field_conflict_across_documents",
  version: "1",
  enabled: (ctx) => ctx.config.crossCheckingEnabled,
  evaluate: (ctx) =>
    ctx.conflicts
      .filter(
        (c) =>
          c.verdict === "conflict" &&
          !c.participants.includes(SCENARIO_RECORD),
      )
      .map((c) =>
        conflictCandidate(
          "field_conflict_across_documents",
          c.field,
          c.values,
          c.participants,
          c.explanation,
        ),
      ),
};

const fieldConflictWithScenarioRecord: Rule = {
  issueType: "field_conflict_with_scenario_record",
  version: "1",
  enabled: (ctx) => ctx.config.crossCheckingEnabled,
  evaluate: (ctx) =>
    ctx.conflicts
      .filter(
        (c) =>
          c.verdict === "conflict" && c.participants.includes(SCENARIO_RECORD),
      )
      .map((c) =>
        conflictCandidate(
          "field_conflict_with_scenario_record",
          c.field,
          c.values,
          c.participants.filter((p) => p !== SCENARIO_RECORD),
          c.explanation,
        ),
      ),
};

const photoMismatch: Rule = {
  issueType: "photo_mismatch",
  version: "1",
  enabled: (ctx) => ctx.config.photoComparisonEnabled,
  evaluate: (ctx) =>
    ctx.photoComparisons
      .filter((p) => p.verdict === "mismatch")
      .map((p) => ({
        issueType: "photo_mismatch",
        source: "ai",
        ruleVersion: "1",
        // Capped: LLM face matching is low-reliability and an accusation.
        severity: capSeverity("high", "medium"),
        affectedField: "photo",
        documentIds: [p.documentA, p.documentB],
        // Confidence drifts run-to-run — kept out of identity.
        salientValues: { verdict: p.verdict },
        templateKey: "photo_mismatch",
        templateParams: { confidence: p.confidence },
        facts: {},
      })),
};

const documentAuthenticitySuspect: Rule = {
  issueType: "document_authenticity_suspect",
  version: "1",
  evaluate: (ctx) =>
    ctx.documents
      .filter((d) => d.authenticityVerdict === "suspect")
      .map((d: ScenarioDocument) => ({
        issueType: "document_authenticity_suspect",
        source: "ai",
        ruleVersion: "1",
        severity: capSeverity("high", "medium"), // capped image judgment
        affectedField: null,
        documentIds: [d.documentId],
        salientValues: { verdict: "suspect" },
        templateKey: "document_authenticity_suspect",
        templateParams: {
          documentTitle: d.title,
          confidence: d.authenticityConfidence,
        },
        facts: { checksum: d.checksum },
      })),
};

export const ALL_RULES: Rule[] = [
  missingRequiredDocument,
  documentExpiryBeforeDeadline,
  deadlineApproachingIncomplete,
  filingNotMarkedSubmitted,
  fieldConflictAcrossDocuments,
  fieldConflictWithScenarioRecord,
  photoMismatch,
  documentAuthenticitySuspect,
];
