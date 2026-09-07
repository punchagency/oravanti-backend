import {
  boolean,
  index,
  integer,
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
import { documents } from "./documents";
import { leads } from "./leads";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { staff } from "./staff";
import { questionnaireQuestionTypeEnum } from "./enums";
import { schemaNodes } from "./schema-nodes";

export const questionnaireLogicActionEnum = pgEnum(
  "questionnaire_logic_action",
  [
    "show_question",
    "hide_question",
    "skip_to_question",
    "skip_to_section",
    "require_question",
    "branch_to_section",
    "end_questionnaire",
  ],
);

export const questionnaireSendStatusEnum = pgEnum("questionnaire_send_status", [
  "sent",
  "opened",
  "draft_response",
  "submitted",
  "expired",
  "revoked",
]);

/**
 * Why the client is being asked, in their words rather than the firm's.
 *
 * A questionnaire link arriving for the second time means something different
 * from the first, and the difference matters to the person receiving it: a
 * correction is a request to change an answer they already gave, and attention
 * is a request to look at something without necessarily changing it. Sending
 * all three as an identical invitation is how a client comes to ignore the
 * third one.
 *
 * Recorded on the send rather than the response because it describes the ask,
 * not the answer — the same response can be asked for repeatedly.
 */
export const questionnaireSendReasonEnum = pgEnum("questionnaire_send_reason", [
  "new",
  "correction",
  "attention",
]);

export const questionnaireResponseStatusEnum = pgEnum(
  "questionnaire_response_status",
  ["draft", "submitted"],
);

/**
 * *When* in a matter's life a questionnaire is asked — and therefore what it is
 * for. A case type has at most one of each.
 *
 * - `intake` — sent to a prospect the moment they contact the firm, before any
 *   case exists. Short and triaging: enough to decide whether to take the
 *   matter and how to open it. A consultation follows; sometimes the attorney
 *   runs the consultation *first* and this is never sent at all.
 * - `case` — asked once the matter is open, of a signed client. Long and
 *   substantive: this is the filing data, and it is what populates the forms.
 *
 * These are genuinely different documents with different audiences, not one
 * questionnaire at two lengths, which is why the stage is a column on the
 * questionnaire rather than a flag on individual questions.
 */
export const questionnaireStageEnum = pgEnum("questionnaire_stage", [
  "intake",
  "case",
]);

export type QuestionnaireStage =
  (typeof questionnaireStageEnum.enumValues)[number];

/**
 * *Who authored* a section or question, and therefore how far it reaches.
 *
 * - `system` — Oravanti's. `organizationId` is NULL; every firm sees it and no
 *   firm may edit it, add to it, or reword it. The locked backbone, maintained
 *   from the Oravanti CRM (`modules/platform`). A firm that wants something
 *   asked differently adds its own question beside ours rather than changing
 *   ours — there was once a copy-on-write that let an edit land as a
 *   firm-scoped duplicate, and it is gone.
 * - `firm` — one org's addition to a case type, on every matter of that type.
 * - `case` — one org's addition to a single matter. `caseId` is set.
 *
 * The three form a narrowing ladder — platform, then firm, then matter — and a
 * reader assembles a questionnaire by taking all three and sorting on
 * `orderIndex`. Adding a tier is a new enum value, not a new table.
 *
 * (`scope: "case"` and `stage: "case"` are unrelated axes that both want the
 * word: the stage says *when the questionnaire is asked*, the scope says *how
 * far one question reaches*. A `scope: "case"` question is only ever found on a
 * `stage: "case"` questionnaire, but the converse is not true — most questions
 * on a case questionnaire are `system`.)
 */
export const questionnaireScopeEnum = pgEnum("questionnaire_scope", [
  "system",
  "firm",
  "case",
]);

export type QuestionnaireScope =
  (typeof questionnaireScopeEnum.enumValues)[number];

// ─── Questionnaires ──────────────────────────────────────────────────────────

/**
 * One questionnaire per (case type, stage) — platform-owned.
 *
 * A firm never gets its own row here. Firm and per-matter additions attach to
 * this questionnaire as `scope`d sections and questions below, which is what
 * keeps "the firm extended the standard AOS questionnaire" a set of extra rows
 * rather than a divergent copy that stops receiving platform updates.
 */
export const questionnaires = pgTable(
  "questionnaires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    stage: questionnaireStageEnum("stage").notNull().default("intake"),
    title: text("title").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("questionnaires_case_type_stage_unique").on(t.caseTypeId, t.stage),
    index("questionnaires_case_type_idx").on(t.caseTypeId),
  ],
);

/**
 * Every section of every questionnaire, at all three scopes.
 *
 * ─── Why one table and not three ────────────────────────────────────────────
 *
 * System and firm sections used to live in `case_type_questionnaire_sections`
 * and `firm_questionnaire_sections`: two tables with the same columns, two sets
 * of CRUD, and a merge step that cast to `any` to line the two row shapes up.
 * Adding per-matter sections would have made that three of everything, and
 * `questionnaire_answers.question_id` — already unconstrained so it could point
 * at either question table — would have had a third possible target.
 *
 * Collapsing them restores the foreign key. That is the real win: an answer now
 * cannot outlive its question, and a question cannot outlive its section.
 */
export const questionnaireSections = pgTable(
  "questionnaire_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id, { onDelete: "cascade" }),
    scope: questionnaireScopeEnum("scope").notNull(),
    /** NULL exactly when `scope` is `system`. See the RLS note in rls.ts. */
    organizationId: text("organization_id").references(() => organization.id),
    /** Set exactly when `scope` is `case`. */
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),

    title: text("title").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("questionnaire_sections_questionnaire_idx").on(t.questionnaireId),
    index("questionnaire_sections_org_idx").on(t.organizationId),
    index("questionnaire_sections_case_idx").on(t.caseId),
  ],
);

export const questionnaireQuestions = pgTable(
  "questionnaire_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id, { onDelete: "cascade" }),
    /**
     * A real foreign key, which the two-table design could not have.
     *
     * A firm or per-matter question may attach to a `system` section — that is
     * the ordinary way of adding "one more question" to a standard section, and
     * it used to need two nullable columns (`system_section_id`,
     * `firm_section_id`) with an "exactly one is set" rule no constraint
     * enforced.
     */
    sectionId: uuid("section_id")
      .notNull()
      .references(() => questionnaireSections.id, { onDelete: "cascade" }),
    scope: questionnaireScopeEnum("scope").notNull(),
    /** NULL exactly when `scope` is `system`. */
    organizationId: text("organization_id").references(() => organization.id),
    /** Set exactly when `scope` is `case`. */
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),

    /**
     * A stable, human-readable name for what this question *asks* — e.g.
     * `beneficiary.date_of_birth`. Distinct from `id`, which changes whenever
     * the seed recreates a row.
     *
     * This is what a form-field mapping points at, so that re-seeding the
     * question bank does not silently unmap every form. Null on questions that
     * feed no form, which is most firm and per-matter ones.
     */
    fieldKey: text("field_key"),
    /**
     * The vocabulary node this question asks for, where it asks for a shared
     * one. `schema_nodes` is the catalogue; see the note on that table.
     *
     * Null is ordinary here and will stay ordinary: a firm's own question asks
     * something only that firm asks, and the 117 Part 9 eligibility questions
     * on the I-485 are asked and printed by exactly one form. What the column
     * buys is the other direction — a question that *meant* to name a shared
     * datum and misspelt it now has somewhere to be found, instead of being
     * discovered as a blank box on a filed petition.
     *
     * A question binds to the node itself, never to one entry of it: an
     * address history is one question answering many times, and which entry a
     * given box prints is the *form field's* business
     * (`form_field_definitions.entry_index`).
     */
    schemaNodeId: uuid("schema_node_id").references(() => schemaNodes.id),


    label: text("label").notNull(),
    description: text("description"),
    type: questionnaireQuestionTypeEnum("type").notNull(),
    orderIndex: integer("order_index").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("questionnaire_questions_questionnaire_idx").on(t.questionnaireId),
    index("questionnaire_questions_section_idx").on(t.sectionId),
    index("questionnaire_questions_org_idx").on(t.organizationId),
    index("questionnaire_questions_case_idx").on(t.caseId),
    index("questionnaire_questions_field_key_idx").on(t.fieldKey),
  ],
);

export const questionnaireLogicRules = pgTable(
  "questionnaire_logic_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id, { onDelete: "cascade" }),
    scope: questionnaireScopeEnum("scope").notNull(),
    organizationId: text("organization_id").references(() => organization.id),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    /**
     * Both ends are now plain foreign keys — the `target_question_source`
     * discriminator the firm rule table needed has no reason to exist.
     *
     * A rule targets a question or a section depending on its `actionType`
     * (`skip_to_section` and `branch_to_section` take the section, the rest
     * take the question), which is why both are nullable.
     */
    sourceQuestionId: uuid("source_question_id")
      .notNull()
      .references(() => questionnaireQuestions.id, { onDelete: "cascade" }),
    targetQuestionId: uuid("target_question_id").references(
      () => questionnaireQuestions.id,
      { onDelete: "cascade" },
    ),
    targetSectionId: uuid("target_section_id").references(
      () => questionnaireSections.id,
      { onDelete: "cascade" },
    ),
    condition: jsonb("condition").notNull().default({}),
    actionType: questionnaireLogicActionEnum("action_type").notNull(),
    action: jsonb("action").notNull().default({}),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("questionnaire_logic_rules_questionnaire_idx").on(t.questionnaireId),
    index("questionnaire_logic_rules_source_idx").on(t.sourceQuestionId),
  ],
);

// ─── Sends & Responses ────────────────────────────────────────────────────────

export const questionnaireSends = pgTable(
  "questionnaire_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    // leadId populated for intake sends; clientId/caseId populated after conversion
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    sentById: uuid("sent_by_id").references(() => staff.id),
    status: questionnaireSendStatusEnum("status").notNull().default("sent"),
    /** Why this send was made. Shown to the client, and kept for the history. */
    reason: questionnaireSendReasonEnum("reason").notNull().default("new"),
    /**
     * What the firm wants the client to do, in free text — "the date of entry
     * on page 2 doesn't match your I-94". Shown alongside the reason, so a
     * correction arrives with the correction in it.
     */
    reasonNote: text("reason_note"),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    schemaSnapshot: jsonb("schema_snapshot"),
    // Delivery + reminder configuration captured from the send wizard.
    deliveryChannels: jsonb("delivery_channels").notNull().default(["email"]),
    language: text("language").notNull().default("english"),
    autoReminderDays: integer("auto_reminder_days"), // null = never
    reminderJobId: text("reminder_job_id"), // BullMQ delayed-job id
    lastReminderAt: timestamp("last_reminder_at"),
    expiresAt: timestamp("expires_at"),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    openedAt: timestamp("opened_at"),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_sends_organization_idx").on(table.organizationId),
    index("questionnaire_sends_lead_idx").on(table.leadId),
    index("questionnaire_sends_client_idx").on(table.clientId),
    index("questionnaire_sends_case_idx").on(table.caseId),
    index("questionnaire_sends_case_type_idx").on(table.caseTypeId),
  ],
);

export const questionnaireResponses = pgTable(
  "questionnaire_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    /**
     * Null when staff filled the questionnaire in-house — on a call, or from
     * documents already on file — rather than sending a link out. A case
     * questionnaire is answered both ways and often both ways in turn, so the
     * send is a delivery mechanism the response does not depend on.
     */
    questionnaireSendId: uuid("questionnaire_send_id").references(
      () => questionnaireSends.id,
    ),
    /** Set exactly when `questionnaireSendId` is null: who typed the answers. */
    filledById: uuid("filled_by_id").references(() => staff.id),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id),
    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    status: questionnaireResponseStatusEnum("status")
      .notNull()
      .default("draft"),
    /** Where the respondent had got to — a plain FK now that sections are one table. */
    currentSectionId: uuid("current_section_id").references(
      () => questionnaireSections.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    lastSavedAt: timestamp("last_saved_at").notNull().defaultNow(),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Still one response per send; NULLs (staff-filled) do not collide.
    unique("questionnaire_responses_send_unique").on(table.questionnaireSendId),
    index("questionnaire_responses_organization_idx").on(table.organizationId),
    index("questionnaire_responses_send_idx").on(table.questionnaireSendId),
    index("questionnaire_responses_lead_idx").on(table.leadId),
    index("questionnaire_responses_case_idx").on(table.caseId),
  ],
);

export const questionnaireAnswers = pgTable(
  "questionnaire_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id, { onDelete: "cascade" }),
    /** A real foreign key since the question tables were consolidated. */
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id, { onDelete: "cascade" }),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_answers_response_question_unique").on(
      table.responseId,
      table.questionId,
    ),
    index("questionnaire_answers_organization_idx").on(table.organizationId),
    index("questionnaire_answers_response_idx").on(table.responseId),
  ],
);

/**
 * Join table only: "this document answers this file_upload question".
 *
 * The file itself lives in `documents` / `document_versions` like every other
 * document in the system — this table no longer carries storage metadata. That
 * normalization is what gives questionnaire uploads versioning, checksums (the
 * AI analysis cache key), and a single access path; and it makes lead→case
 * conversion a relink rather than a byte-identical copy under a new id.
 *
 * Lead linkage lives on `lead_document_links`, not here.
 */
export const questionnaireResponseFiles = pgTable(
  "questionnaire_response_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_response_files_response_idx").on(table.responseId),
    index("questionnaire_response_files_organization_idx").on(
      table.organizationId,
    ),
    index("questionnaire_response_files_document_idx").on(table.documentId),
    // One document per question per response — re-answering replaces the row.
    unique("questionnaire_response_files_response_question_unique").on(
      table.responseId,
      table.questionId,
    ),
  ],
);

/**
 * ─── Answer history ─────────────────────────────────────────────────────────
 *
 * Two tables, because "what did this look like on Tuesday?" and "who changed
 * this date, and from what?" are different questions and one shape answers
 * them badly.
 *
 * `questionnaire_response_versions` is the snapshot: one row per save, holding
 * every answer as it stood. It is what restore-to-a-point-in-time reads, and
 * it is cheap because an explicit per-section Save means a handful of saves per
 * matter rather than one per keystroke.
 *
 * `questionnaire_answer_revisions` is the change log: one row per answer that
 * actually moved, carrying what it moved from. It is what a single answer's
 * timeline reads, and what makes "who put 1991 here?" answerable without
 * diffing two snapshots.
 *
 * Both are append-only. A restore writes a *new* save rather than deleting the
 * versions after it — history that can be rewritten is not history, and a
 * colleague's correction must never vanish because somebody rolled back past
 * it.
 */
export const questionnaireVersionActorEnum = pgEnum(
  "questionnaire_version_actor",
  ["staff", "client"],
);

export const questionnaireResponseVersions = pgTable(
  "questionnaire_response_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id, { onDelete: "cascade" }),
    /** 1, 2, 3… within a response. What staff actually call the version. */
    versionNumber: integer("version_number").notNull(),
    actor: questionnaireVersionActorEnum("actor").notNull(),
    /** Null for a client save — the client is identified by the response. */
    savedById: uuid("saved_by_id").references(() => staff.id),
    /**
     * Every answer as it stood after this save, `{ questionId: value }`.
     *
     * Stored whole rather than as a diff: restoring is then a write of what is
     * already here, with no replay through every intervening version, and a
     * question deleted since the save simply has no home to restore into
     * rather than corrupting the chain.
     */
    answers: jsonb("answers").notNull(),
    /** How many answers this save changed. Denormalised for the version list. */
    changedCount: integer("changed_count").notNull().default(0),
    /** The section saved, when the save came from one. Null for a full save. */
    sectionId: uuid("section_id").references(() => questionnaireSections.id, {
      onDelete: "set null",
    }),
    /** Set when this save was itself a restore, naming what it restored. */
    restoredFromVersionId: uuid("restored_from_version_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("questionnaire_response_versions_number_unique").on(
      t.responseId,
      t.versionNumber,
    ),
    index("questionnaire_response_versions_response_idx").on(t.responseId),
    index("questionnaire_response_versions_org_idx").on(t.organizationId),
  ],
);

export const questionnaireAnswerRevisions = pgTable(
  "questionnaire_answer_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id, { onDelete: "cascade" }),
    /** The save this change belonged to, so a version can list its changes. */
    versionId: uuid("version_id")
      .notNull()
      .references(() => questionnaireResponseVersions.id, {
        onDelete: "cascade",
      }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id, { onDelete: "cascade" }),
    /** Null on the first answer to a question — there was nothing before it. */
    previousValue: jsonb("previous_value"),
    /** Null when the answer was cleared. */
    value: jsonb("value"),
    actor: questionnaireVersionActorEnum("actor").notNull(),
    changedById: uuid("changed_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("questionnaire_answer_revisions_response_idx").on(t.responseId),
    index("questionnaire_answer_revisions_version_idx").on(t.versionId),
    // The per-answer timeline is the whole point of this table, and it is read
    // newest-first for one question at a time.
    index("questionnaire_answer_revisions_question_idx").on(
      t.questionId,
      t.createdAt,
    ),
    index("questionnaire_answer_revisions_org_idx").on(t.organizationId),
  ],
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type Questionnaire = typeof questionnaires.$inferSelect;
export type QuestionnaireSection = typeof questionnaireSections.$inferSelect;
export type QuestionnaireQuestion = typeof questionnaireQuestions.$inferSelect;
export type QuestionnaireLogicRule = typeof questionnaireLogicRules.$inferSelect;
export type QuestionnaireSend = typeof questionnaireSends.$inferSelect;
export type QuestionnaireResponse = typeof questionnaireResponses.$inferSelect;
export type QuestionnaireAnswer = typeof questionnaireAnswers.$inferSelect;
export type QuestionnaireResponseFile =
  typeof questionnaireResponseFiles.$inferSelect;
export type QuestionnaireResponseVersion =
  typeof questionnaireResponseVersions.$inferSelect;
export type QuestionnaireAnswerRevision =
  typeof questionnaireAnswerRevisions.$inferSelect;
