import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";
import { documents } from "./documents";
import { leads } from "./leads";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { staff } from "./staff";

/**
 * Where a materialized requirement came from.
 * - `questionnaire` — snapshotted from a `file_upload` question at send time
 * - `template`      — materialized from `case_type_document_requirements`
 * - `firm`          — added ad-hoc by firm staff on this specific matter
 */
export const documentRequirementSourceEnum = pgEnum(
  "document_requirement_source",
  ["questionnaire", "template", "firm"],
);

/**
 * What a due date is measured against, instead of a hardcoded calendar date —
 * lets a requirement or workflow step express "14 days before the interview"
 * and get a date derived from the matter's own milestones.
 *
 * Originally `requirement_due_anchor`, scoped to document requirements only.
 * Renamed and extended to `date_anchor` so `workflow_template_steps.due_date_anchor`
 * (see workflow.ts) can reuse the same vocabulary and the same `resolveDueDate`
 * function instead of maintaining two parallel anchor concepts. Every value below
 * is cited by a specific step in `.claude/workflows/04-personal-injury-template.md`
 * or `05-immigration-template.md` — extend by appending, never repurpose a value.
 */
export const dateAnchorEnum = pgEnum("date_anchor", [
  // pre-existing (document requirements)
  "uscis_interview",
  "filing_deadline",
  "next_court_date",
  "case_opened",
  /**
   * When the step's own module first became active on this matter — see
   * `workflowModuleActivations`. The anchor for a conditional module, whose
   * work does not become possible until its condition holds; `case_opened`
   * would date it from a point years before anyone could have started.
   */
  "module_activated",
  // immigration — AOS / N-400 / mandamus
  "receipt_date",
  "biometrics_appointment",
  "card_valid_to",
  "interview_scheduled_date",
  "decision_date",
  "green_card_expiration_date",
  "eligibility_date",
  "oath_ceremony_date",
  "demand_letter_sent_date",
  "service_completed_date",
  "filed_date",
  // Appended after the initial list in `.claude/workflows/01-data-model.md §3`:
  // that list omits `ruling_date`, but §05's Mandamus Module M8 step 1 anchors on
  // it and `immigrationCaseDetails.rulingDate` already exists — an append, which
  // is exactly how §3 says the vocabulary grows.
  "ruling_date",
  // personal injury
  "incident_date",
  "statute_of_limitations_date",
  "mmi_date",
  "demand_sent_date",
  "defendant_answer_date",
  "msj_filed_date",
  "mediation_scheduled_date",
  "trial_date",
  "verdict_date",
  "funds_received_date",
]);

/**
 * Reusable, firm-authored checklist per case type. Editing a template row does
 * NOT rewrite matters already materialized from it — that audit-stability
 * property is the whole reason requirements are materialized rather than
 * derived at query time.
 */
export const caseTypeDocumentRequirements = pgTable(
  "case_type_document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** Closed-vocabulary slug matched against the AI's `document_type` fact. */
    documentTypeSlug: text("document_type_slug"),
    isRequired: boolean("is_required").notNull().default(true),
    orderIndex: integer("order_index").notNull().default(0),
    dueDateOffsetDays: integer("due_date_offset_days"),
    dueDateAnchor: dateAnchorEnum("due_date_anchor"),
    /** Retire a template row without touching already-materialized matters. */
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("ctdr_organization_idx").on(table.organizationId),
    index("ctdr_case_type_idx").on(table.caseTypeId),
  ],
);

/**
 * The per-matter checklist the rules engine actually reads. Exactly one of
 * `leadId` / `caseId` is set — mirroring the `lead_document_links` /
 * `document_case_links` idiom, which keeps real FK integrity and cascade
 * deletes instead of a polymorphic (type, id) pair.
 *
 * On lead→case conversion these rows are MOVED (leadId → null, caseId → set),
 * so identity and `satisfiedByDocumentId` carry over on a single row.
 */
export const scenarioDocumentRequirements = pgTable(
  "scenario_document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),

    label: text("label").notNull(),
    documentTypeSlug: text("document_type_slug"),
    isRequired: boolean("is_required").notNull().default(true),
    orderIndex: integer("order_index").notNull().default(0),
    source: documentRequirementSourceEnum("source").notNull(),

    /**
     * Provenance — set when `source` is `questionnaire`. Deliberately NOT a
     * foreign key: this is a question id from the send's `schemaSnapshot`,
     * which may originate from `case_type_questionnaire_questions`, from
     * `firm_questionnaire_questions`, or be generated on the fly for an ad-hoc
     * "requested documents" section. No single table can back it.
     */
    questionnaireQuestionId: uuid("questionnaire_question_id"),
    /** Provenance — set when `source` is `template`. */
    caseTypeRequirementId: uuid("case_type_requirement_id").references(
      () => caseTypeDocumentRequirements.id,
    ),

    /**
     * Satisfaction is a single uniform path regardless of source. Questionnaire
     * uploads set this automatically (the question→requirement mapping is
     * known); for template/firm rows the AI's document-type slug only ever
     * SUGGESTS a match — a human confirms. An AI silently satisfying a
     * requirement is how a genuinely missing document stops being flagged.
     */
    satisfiedByDocumentId: uuid("satisfied_by_document_id").references(
      () => documents.id,
    ),
    satisfiedAt: timestamp("satisfied_at"),

    dueDate: date("due_date"),

    /** Clear a requirement that doesn't apply, instead of dismissing its issue forever. */
    waivedAt: timestamp("waived_at"),
    waivedById: uuid("waived_by_id").references(() => staff.id),
    waiveReason: text("waive_reason"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "sdr_exactly_one_scenario",
      sql`(${table.leadId} IS NOT NULL)::int + (${table.caseId} IS NOT NULL)::int = 1`,
    ),
    index("sdr_organization_idx").on(table.organizationId),
    index("sdr_lead_idx").on(table.leadId),
    index("sdr_case_idx").on(table.caseId),
    index("sdr_satisfied_by_document_idx").on(table.satisfiedByDocumentId),
    // A questionnaire question maps to at most one requirement per matter.
    unique("sdr_lead_question_unique").on(table.leadId, table.questionnaireQuestionId),
  ],
);

export type DateAnchor = (typeof dateAnchorEnum.enumValues)[number];

export type CaseTypeDocumentRequirement =
  typeof caseTypeDocumentRequirements.$inferSelect;
export type NewCaseTypeDocumentRequirement =
  typeof caseTypeDocumentRequirements.$inferInsert;
export type ScenarioDocumentRequirement =
  typeof scenarioDocumentRequirements.$inferSelect;
export type NewScenarioDocumentRequirement =
  typeof scenarioDocumentRequirements.$inferInsert;
