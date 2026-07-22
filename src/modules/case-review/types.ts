import type { SalientValues } from "./fingerprint";

/**
 * Inputs and outputs of the rules engine.
 *
 * Rules are pure: (RuleContext) => CandidateIssue[]. The context is assembled by
 * a builder that reads the scenario's facts, requirements and deadlines from the
 * DB plus the fresh AI scan result; the diff engine turns candidates into
 * persisted case_issues via their fingerprint.
 */

export type ScenarioType = "lead" | "case";

export type ScenarioRef = {
  type: ScenarioType;
  id: string;
  organizationId: string;
  /** Null for a lead (no client until conversion). */
  clientId: string | null;
};

/** A scenario document with its latest AI facts (from document_analyses). */
export type ScenarioDocument = {
  documentId: string;
  checksum: string;
  title: string;
  documentType: string | null;
  extractedFields: Record<string, string>;
  hasPhoto: boolean;
  authenticityVerdict: "genuine" | "suspect" | "indeterminate" | null;
  authenticityConfidence: number | null;
};

/** A materialized requirement with its effective (manual-or-derived) due date. */
export type Requirement = {
  id: string;
  label: string;
  documentTypeSlug: string | null;
  isRequired: boolean;
  satisfiedByDocumentId: string | null;
  waivedAt: Date | null;
  effectiveDueDate: Date | null;
};

/** Deadlines resolved for the scenario (calendar_events spine + cases fallback). */
export type Deadlines = {
  /** Nearest upcoming scheduled uscis_interview. */
  interviewDate: Date | null;
  /** Nearest upcoming scheduled filing_deadline. */
  filingDeadline: Date | null;
  /** Whether the matter's filing has been marked submitted. */
  filingSubmitted: boolean;
};

/** A cross-reference conflict from the AI scan result (participants are doc ids
 *  or the sentinel "scenario_record"). */
export type Conflict = {
  field: string;
  participants: string[];
  values: Record<string, string>;
  verdict: string;
  explanation: string;
};

export type PhotoComparison = {
  documentA: string;
  documentB: string;
  verdict: "match" | "mismatch" | "indeterminate";
  confidence: number;
};

export type RuleContext = {
  scenario: ScenarioRef;
  now: Date;
  documents: ScenarioDocument[];
  requirements: Requirement[];
  deadlines: Deadlines;
  conflicts: Conflict[];
  photoComparisons: PhotoComparison[];
  config: {
    crossCheckingEnabled: boolean;
    photoComparisonEnabled: boolean;
  };
};

export type Severity = "critical" | "high" | "medium" | "low";
export type IssueSource = "rule" | "ai";

/**
 * A candidate issue a rule produces. The diff engine derives the fingerprint
 * from (scenario, issueType, affectedField, documentIds, salientValues) and
 * renders prose from templateKey + templateParams at read time.
 */
export type CandidateIssue = {
  issueType: string;
  source: IssueSource;
  ruleVersion: string;
  severity: Severity;
  affectedField: string | null;
  documentIds: string[];
  salientValues: SalientValues;
  templateKey: string;
  templateParams: Record<string, unknown>;
  facts: Record<string, unknown>;
};

export type Rule = {
  issueType: string;
  version: string;
  /** Config gate (e.g. photo comparison off). Defaults to always-on. */
  enabled?: (ctx: RuleContext) => boolean;
  evaluate: (ctx: RuleContext) => CandidateIssue[];
};
