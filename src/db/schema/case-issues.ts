import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";
import { clients } from "./clients";
import { documents, documentVersions } from "./documents";
import { leads } from "./leads";
import { staff } from "./staff";

/**
 * Severity retains four values. The dashboard collapses them for display —
 * {critical, high} → "Critical", {medium, low} → "Warning" — but that mapping
 * is a presentation concern and deliberately does not live in the schema.
 */
export const issueSeverityEnum = pgEnum("issue_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const issueStatusEnum = pgEnum("issue_status", [
  "open",
  "under_review",
  "resolved",
  "dismissed",
  /** The issue's underlying facts changed or it no longer applies. */
  "superseded",
]);

/**
 * Whether an issue was produced by a deterministic backend rule or derived from
 * an AI observation. Most issues (missing document, deadline risk, unfiled
 * court filing) are pure database rules with no LLM involvement — modelling
 * this honestly is why the table is not called `ai_error_flags`.
 */
export const issueSourceEnum = pgEnum("issue_source", ["rule", "ai"]);

/** How a document participates in an issue. */
export const issueDocumentRoleEnum = pgEnum("issue_document_role", [
  "subject",
  "counterpart",
]);

/**
 * Issues surfaced on the "AI case review" dashboard.
 *
 * Identity is two-tier so reruns can distinguish "unchanged" from "changed":
 *   issue_key    = hash(scenario, issue_type, field, sorted(document_ids))
 *   content_hash = hash(normalized(salient_values))
 *
 * same key + same content  → still open, preserve resolution, do not touch
 * same key + diff content  → substance changed, supersede + reopen
 * key absent from a run    → superseded
 *
 * LLM prose and severity are deliberately EXCLUDED from both hashes — they
 * drift between runs and would mint phantom issues. Prose is rendered at read
 * time from `templateKey` + `templateParams` in the firm's language, never
 * stored.
 */
export const caseIssues = pgTable(
  "case_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    /** Nullable — a lead has no client until conversion. */
    clientId: uuid("client_id").references(() => clients.id),

    issueKey: text("issue_key").notNull(),
    contentHash: text("content_hash").notNull(),
    issueType: text("issue_type").notNull(),
    source: issueSourceEnum("source").notNull(),
    /** Audit only — deliberately NOT a hash input, or every rule tweak would
     *  resurrect every resolved issue. */
    ruleVersion: text("rule_version").notNull(),

    severity: issueSeverityEnum("severity").notNull(),
    status: issueStatusEnum("status").notNull().default("open"),

    affectedField: text("affected_field"),
    /** The facts that produced this issue, for audit and re-evaluation. */
    facts: jsonb("facts").notNull().default({}),
    /** Prose is rendered from these at read time, in the firm's language. */
    templateKey: text("template_key").notNull(),
    templateParams: jsonb("template_params").notNull().default({}),

    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    resolvedById: uuid("resolved_by_id").references(() => staff.id),
    resolvedAt: timestamp("resolved_at"),
    dismissedById: uuid("dismissed_by_id").references(() => staff.id),
    dismissedAt: timestamp("dismissed_at"),
    supersededAt: timestamp("superseded_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "case_issues_exactly_one_scenario",
      sql`(${table.leadId} IS NOT NULL)::int + (${table.caseId} IS NOT NULL)::int = 1`,
    ),
    // Makes the writer an upsert rather than a duplicate-on-every-rerun insert.
    unique("case_issues_org_issue_key_unique").on(
      table.organizationId,
      table.issueKey,
    ),
    index("case_issues_organization_idx").on(table.organizationId),
    index("case_issues_lead_idx").on(table.leadId),
    index("case_issues_case_idx").on(table.caseId),
    index("case_issues_status_idx").on(table.status),
    index("case_issues_severity_idx").on(table.severity),
  ],
);

/**
 * Which documents an issue involves. A cross-document conflict involves two or
 * more documents, which a single `documentId` column could not express — that
 * limitation is why the previous `ai_error_flags` table was replaced.
 */
export const caseIssueDocuments = pgTable(
  "case_issue_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => caseIssues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    /** The exact version the finding was made against. */
    documentVersionId: uuid("document_version_id").references(
      () => documentVersions.id,
    ),
    role: issueDocumentRoleEnum("role").notNull().default("subject"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("case_issue_documents_issue_document_unique").on(
      table.issueId,
      table.documentId,
    ),
    index("case_issue_documents_issue_idx").on(table.issueId),
    index("case_issue_documents_document_idx").on(table.documentId),
  ],
);

/**
 * Append-only status transitions. This is the dashboard's "Resolution log" —
 * every resolve / dismiss / reopen / supersede writes a row here.
 */
export const caseIssueEvents = pgTable(
  "case_issue_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => caseIssues.id, { onDelete: "cascade" }),
    fromStatus: issueStatusEnum("from_status"),
    toStatus: issueStatusEnum("to_status").notNull(),
    /** Null for system transitions (e.g. a rerun superseding an issue). */
    actorStaffId: uuid("actor_staff_id").references(() => staff.id),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("case_issue_events_issue_idx").on(table.issueId, table.createdAt),
  ],
);

export type CaseIssue = typeof caseIssues.$inferSelect;
export type NewCaseIssue = typeof caseIssues.$inferInsert;
export type CaseIssueDocument = typeof caseIssueDocuments.$inferSelect;
export type NewCaseIssueDocument = typeof caseIssueDocuments.$inferInsert;
export type CaseIssueEvent = typeof caseIssueEvents.$inferSelect;
export type NewCaseIssueEvent = typeof caseIssueEvents.$inferInsert;
