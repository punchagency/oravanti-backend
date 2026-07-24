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

// ─── Shared Enums ────────────────────────────────────────────────────────────

export const questionnaireQuestionTypeEnum = pgEnum(
  "questionnaire_question_type",
  [
    "short_text",
    "long_text",
    "number",
    "email",
    "phone",
    "date",
    "time",
    "single_choice",
    "multiple_choice",
    "dropdown",
    "rating_scale",
    "file_upload",
    "yes_no",
    "matrix_grid",
    "signature",
  ],
);

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

export const questionnaireResponseStatusEnum = pgEnum(
  "questionnaire_response_status",
  ["draft", "submitted"],
);

export const questionSourceEnum = pgEnum("question_source", ["system", "firm"]);

// ─── System Questionnaires (platform-owned, one per case type) ────────────────

export const caseTypeQuestionnaires = pgTable(
  "case_type_questionnaires",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    caseTypeId:  uuid("case_type_id").notNull().unique().references(() => practiceAreaCaseTypes.id),
    title:       text("title").notNull(),
    description: text("description"),
    createdAt:   timestamp("created_at").notNull().defaultNow(),
    updatedAt:   timestamp("updated_at").notNull().defaultNow(),
  },
);

export const caseTypeQuestionnaireSections = pgTable(
  "case_type_questionnaire_sections",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id").notNull().references(() => caseTypeQuestionnaires.id),
    title:           text("title").notNull(),
    description:     text("description"),
    orderIndex:      integer("order_index").notNull(),
    createdAt:       timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("ctqs_questionnaire_idx").on(table.questionnaireId),
  ],
);

export const caseTypeQuestionnaireQuestions = pgTable(
  "case_type_questionnaire_questions",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id").notNull().references(() => caseTypeQuestionnaires.id),
    sectionId:       uuid("section_id").notNull().references(() => caseTypeQuestionnaireSections.id),
    label:           text("label").notNull(),
    description:     text("description"),
    type:            questionnaireQuestionTypeEnum("type").notNull(),
    orderIndex:      integer("order_index").notNull(),
    isRequired:      boolean("is_required").notNull().default(false),
    config:          jsonb("config").notNull().default({}),
    createdAt:       timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("ctqq_questionnaire_idx").on(table.questionnaireId),
    index("ctqq_section_idx").on(table.sectionId),
  ],
);

export const caseTypeQuestionnaireLogicRules = pgTable(
  "case_type_questionnaire_logic_rules",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    questionnaireId:  uuid("questionnaire_id").notNull().references(() => caseTypeQuestionnaires.id),
    sourceQuestionId: uuid("source_question_id").notNull().references(() => caseTypeQuestionnaireQuestions.id),
    condition:        jsonb("condition").notNull().default({}),
    actionType:       questionnaireLogicActionEnum("action_type").notNull(),
    action:           jsonb("action").notNull().default({}),
    priority:         integer("priority").notNull().default(0),
    createdAt:        timestamp("created_at").notNull().defaultNow(),
    updatedAt:        timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("ctqlr_questionnaire_idx").on(table.questionnaireId),
  ],
);

// ─── Firm Questionnaire Additions (org-scoped, addable not removable system qs)

export const firmQuestionnaireSections = pgTable(
  "firm_questionnaire_sections",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    caseTypeId:     uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id),
    title:          text("title").notNull(),
    description:    text("description"),
    orderIndex:     integer("order_index").notNull(),
    createdAt:      timestamp("created_at").notNull().defaultNow(),
    updatedAt:      timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("fqs_org_case_type_order_unique").on(table.organizationId, table.caseTypeId, table.orderIndex),
    index("fqs_org_case_type_idx").on(table.organizationId, table.caseTypeId),
  ],
);

export const firmQuestionnaireQuestions = pgTable(
  "firm_questionnaire_questions",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    caseTypeId:     uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id),
    // Exactly one of these is set — attaches to a system section OR a firm section
    systemSectionId: uuid("system_section_id").references(() => caseTypeQuestionnaireSections.id),
    firmSectionId:   uuid("firm_section_id").references(() => firmQuestionnaireSections.id),
    label:          text("label").notNull(),
    description:    text("description"),
    type:           questionnaireQuestionTypeEnum("type").notNull(),
    orderIndex:     integer("order_index").notNull(),
    isRequired:     boolean("is_required").notNull().default(false),
    config:         jsonb("config").notNull().default({}),
    createdAt:      timestamp("created_at").notNull().defaultNow(),
    updatedAt:      timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("fqq_org_case_type_idx").on(table.organizationId, table.caseTypeId),
  ],
);

export const firmQuestionnaireLogicRules = pgTable(
  "firm_questionnaire_logic_rules",
  {
    id:                   uuid("id").primaryKey().defaultRandom(),
    organizationId:       text("organization_id").notNull().references(() => organization.id),
    caseTypeId:           uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id),
    sourceQuestionId:     uuid("source_question_id").notNull().references(() => firmQuestionnaireQuestions.id),
    targetQuestionSource: questionSourceEnum("target_question_source").notNull(),
    targetQuestionId:     uuid("target_question_id").notNull(),
    condition:            jsonb("condition").notNull().default({}),
    actionType:           questionnaireLogicActionEnum("action_type").notNull(),
    action:               jsonb("action").notNull().default({}),
    priority:             integer("priority").notNull().default(0),
    createdAt:            timestamp("created_at").notNull().defaultNow(),
    updatedAt:            timestamp("updated_at").notNull().defaultNow(),
  },
);

// ─── Sends & Responses ────────────────────────────────────────────────────────

export const questionnaireSends = pgTable(
  "questionnaire_sends",
  {
    id:                      uuid("id").primaryKey().defaultRandom(),
    organizationId:          text("organization_id").notNull().references(() => organization.id),
    caseTypeQuestionnaireId: uuid("case_type_questionnaire_id").notNull().references(() => caseTypeQuestionnaires.id),
    // leadId populated for intake sends; clientId/caseId populated after conversion
    leadId:   uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id),
    caseId:   uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id),
    sentById:   uuid("sent_by_id").references(() => staff.id),
    status:     questionnaireSendStatusEnum("status").notNull().default("sent"),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    schemaSnapshot:  jsonb("schema_snapshot"),
    // Delivery + reminder configuration captured from the send wizard.
    deliveryChannels: jsonb("delivery_channels").notNull().default(["email"]),
    language:         text("language").notNull().default("english"),
    autoReminderDays: integer("auto_reminder_days"), // null = never
    reminderJobId:    text("reminder_job_id"),        // BullMQ delayed-job id
    lastReminderAt:   timestamp("last_reminder_at"),
    expiresAt:  timestamp("expires_at"),
    sentAt:     timestamp("sent_at").notNull().defaultNow(),
    openedAt:   timestamp("opened_at"),
    submittedAt: timestamp("submitted_at"),
    createdAt:  timestamp("created_at").notNull().defaultNow(),
    updatedAt:  timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_sends_organization_idx").on(table.organizationId),
    index("questionnaire_sends_lead_idx").on(table.leadId),
    index("questionnaire_sends_client_idx").on(table.clientId),
    index("questionnaire_sends_case_type_idx").on(table.caseTypeId),
  ],
);

export const questionnaireResponses = pgTable(
  "questionnaire_responses",
  {
    id:                      uuid("id").primaryKey().defaultRandom(),
    organizationId:          text("organization_id").notNull().references(() => organization.id),
    questionnaireSendId:     uuid("questionnaire_send_id").notNull().references(() => questionnaireSends.id),
    caseTypeQuestionnaireId: uuid("case_type_questionnaire_id").notNull().references(() => caseTypeQuestionnaires.id),
    leadId:   uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id),
    caseId:   uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id),
    status:     questionnaireResponseStatusEnum("status").notNull().default("draft"),
    // { source: 'system' | 'firm', id: string }
    currentSectionRef: jsonb("current_section_ref"),
    startedAt:    timestamp("started_at").notNull().defaultNow(),
    lastSavedAt:  timestamp("last_saved_at").notNull().defaultNow(),
    submittedAt:  timestamp("submitted_at"),
    createdAt:    timestamp("created_at").notNull().defaultNow(),
    updatedAt:    timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_responses_send_unique").on(table.questionnaireSendId),
    index("questionnaire_responses_organization_idx").on(table.organizationId),
    index("questionnaire_responses_send_idx").on(table.questionnaireSendId),
    index("questionnaire_responses_lead_idx").on(table.leadId),
  ],
);

export const questionnaireAnswers = pgTable(
  "questionnaire_answers",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    responseId:     uuid("response_id").notNull().references(() => questionnaireResponses.id),
    // questionId references caseTypeQuestionnaireQuestions OR firmQuestionnaireQuestions
    // based on questionSource — no FK constraint to allow dual-table reference
    questionId:     uuid("question_id").notNull(),
    questionSource: questionSourceEnum("question_source").notNull(),
    value:          jsonb("value").notNull(),
    createdAt:      timestamp("created_at").notNull().defaultNow(),
    updatedAt:      timestamp("updated_at").notNull().defaultNow(),
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
    id:             uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),
    responseId:     uuid("response_id").notNull().references(() => questionnaireResponses.id),
    documentId:     uuid("document_id").notNull().references(() => documents.id),
    questionId:     uuid("question_id").notNull(),
    questionSource: questionSourceEnum("question_source").notNull(),
    createdAt:      timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_response_files_response_idx").on(table.responseId),
    index("questionnaire_response_files_organization_idx").on(table.organizationId),
    index("questionnaire_response_files_document_idx").on(table.documentId),
    // One document per question per response — re-answering replaces the row.
    unique("questionnaire_response_files_response_question_unique").on(
      table.responseId,
      table.questionId,
    ),
  ],
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type CaseTypeQuestionnaire        = typeof caseTypeQuestionnaires.$inferSelect;
export type CaseTypeQuestionnaireSection = typeof caseTypeQuestionnaireSections.$inferSelect;
export type CaseTypeQuestionnaireQuestion = typeof caseTypeQuestionnaireQuestions.$inferSelect;
export type CaseTypeQuestionnaireLogicRule = typeof caseTypeQuestionnaireLogicRules.$inferSelect;
export type FirmQuestionnaireSection     = typeof firmQuestionnaireSections.$inferSelect;
export type FirmQuestionnaireQuestion    = typeof firmQuestionnaireQuestions.$inferSelect;
export type FirmQuestionnaireLogicRule   = typeof firmQuestionnaireLogicRules.$inferSelect;
export type QuestionnaireSend            = typeof questionnaireSends.$inferSelect;
export type QuestionnaireResponse        = typeof questionnaireResponses.$inferSelect;
export type QuestionnaireAnswer          = typeof questionnaireAnswers.$inferSelect;
export type QuestionnaireResponseFile    = typeof questionnaireResponseFiles.$inferSelect;
