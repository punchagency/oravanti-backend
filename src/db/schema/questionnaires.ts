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
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { staff } from "./staff";

export const questionnaireStatusEnum = pgEnum("questionnaire_status", [
  "draft",
  "published",
  "archived",
]);

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

export const questionnaires = pgTable(
  "questionnaires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    title: text("title").notNull(),
    description: text("description"),
    status: questionnaireStatusEnum("status").notNull().default("draft"),
    createdById: uuid("created_by_id").references(() => staff.id),
    sourceQuestionnaireId: uuid("source_questionnaire_id"),
    publishedVersionId: uuid("published_version_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaires_organization_idx").on(table.organizationId),
    index("questionnaires_status_idx").on(table.status),
  ],
);

export const questionnaireVersions = pgTable(
  "questionnaire_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    schemaSnapshot: jsonb("schema_snapshot"),
    publishedAt: timestamp("published_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_versions_number_unique").on(
      table.questionnaireId,
      table.versionNumber,
    ),
    index("questionnaire_versions_questionnaire_idx").on(table.questionnaireId),
    index("questionnaire_versions_organization_idx").on(table.organizationId),
  ],
);

export const questionnaireCaseTypes = pgTable(
  "questionnaire_case_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_case_types_unique").on(
      table.questionnaireId,
      table.caseTypeId,
    ),
    index("questionnaire_case_types_questionnaire_idx").on(
      table.questionnaireId,
    ),
    index("questionnaire_case_types_case_type_idx").on(table.caseTypeId),
  ],
);

export const questionnaireVersionCaseTypes = pgTable(
  "questionnaire_version_case_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_version_case_types_unique").on(
      table.questionnaireVersionId,
      table.caseTypeId,
    ),
    index("questionnaire_version_case_types_version_idx").on(
      table.questionnaireVersionId,
    ),
    index("questionnaire_version_case_types_questionnaire_idx").on(
      table.questionnaireId,
    ),
    index("questionnaire_version_case_types_case_type_idx").on(
      table.caseTypeId,
    ),
  ],
);

export const questionnaireSections = pgTable(
  "questionnaire_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    versionId: uuid("version_id").references(() => questionnaireVersions.id),
    title: text("title").notNull(),
    description: text("description"),
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_sections_questionnaire_idx").on(table.questionnaireId),
    index("questionnaire_sections_version_idx").on(table.versionId),
  ],
);

export const questionnaireQuestions = pgTable(
  "questionnaire_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => questionnaireSections.id),
    versionId: uuid("version_id").references(() => questionnaireVersions.id),
    label: text("label").notNull(),
    description: text("description"),
    type: questionnaireQuestionTypeEnum("type").notNull(),
    orderIndex: integer("order_index").notNull(),
    isRequired: boolean("is_required").notNull().default(false),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_questions_questionnaire_idx").on(table.questionnaireId),
    index("questionnaire_questions_section_idx").on(table.sectionId),
    index("questionnaire_questions_version_idx").on(table.versionId),
  ],
);

export const questionnaireQuestionOptions = pgTable(
  "questionnaire_question_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id),
    label: text("label").notNull(),
    value: text("value").notNull(),
    orderIndex: integer("order_index").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_options_question_idx").on(table.questionId),
    unique("questionnaire_options_value_unique").on(
      table.questionId,
      table.value,
    ),
  ],
);

export const questionnaireLogicRules = pgTable(
  "questionnaire_logic_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    versionId: uuid("version_id").references(() => questionnaireVersions.id),
    sourceQuestionId: uuid("source_question_id").references(
      () => questionnaireQuestions.id,
    ),
    condition: jsonb("condition").notNull().default({}),
    actionType: questionnaireLogicActionEnum("action_type").notNull(),
    action: jsonb("action").notNull().default({}),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_logic_questionnaire_idx").on(table.questionnaireId),
    index("questionnaire_logic_version_idx").on(table.versionId),
    index("questionnaire_logic_source_question_idx").on(
      table.sourceQuestionId,
    ),
  ],
);

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
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    caseId: uuid("case_id").references(() => cases.id),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    sentById: uuid("sent_by_id").references(() => staff.id),
    status: questionnaireSendStatusEnum("status").notNull().default("sent"),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at"),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
    openedAt: timestamp("opened_at"),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_sends_organization_idx").on(table.organizationId),
    index("questionnaire_sends_questionnaire_idx").on(table.questionnaireId),
    index("questionnaire_sends_client_idx").on(table.clientId),
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
    questionnaireSendId: uuid("questionnaire_send_id")
      .notNull()
      .references(() => questionnaireSends.id),
    questionnaireId: uuid("questionnaire_id")
      .notNull()
      .references(() => questionnaires.id),
    questionnaireVersionId: uuid("questionnaire_version_id")
      .notNull()
      .references(() => questionnaireVersions.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    caseId: uuid("case_id").references(() => cases.id),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id),
    status: questionnaireResponseStatusEnum("status").notNull().default("draft"),
    currentSectionId: uuid("current_section_id").references(
      () => questionnaireSections.id,
    ),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    lastSavedAt: timestamp("last_saved_at").notNull().defaultNow(),
    submittedAt: timestamp("submitted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_responses_send_client_unique").on(
      table.questionnaireSendId,
      table.clientId,
    ),
    index("questionnaire_responses_organization_idx").on(table.organizationId),
    index("questionnaire_responses_questionnaire_idx").on(
      table.questionnaireId,
    ),
    index("questionnaire_responses_send_idx").on(table.questionnaireSendId),
    index("questionnaire_responses_case_type_idx").on(table.caseTypeId),
  ],
);

export const questionnaireAnswers = pgTable(
  "questionnaire_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("questionnaire_answers_response_question_unique").on(
      table.responseId,
      table.questionId,
    ),
    index("questionnaire_answers_response_idx").on(table.responseId),
    index("questionnaire_answers_question_idx").on(table.questionId),
  ],
);

export const questionnaireResponseFiles = pgTable(
  "questionnaire_response_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    responseId: uuid("response_id")
      .notNull()
      .references(() => questionnaireResponses.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questionnaireQuestions.id),
    storagePath: text("storage_path").notNull(),
    fileUrl: text("file_url").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    originalFilename: text("original_filename").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("questionnaire_response_files_response_idx").on(table.responseId),
    index("questionnaire_response_files_question_idx").on(table.questionId),
    index("questionnaire_response_files_organization_idx").on(
      table.organizationId,
    ),
  ],
);

export type Questionnaire = typeof questionnaires.$inferSelect;
export type NewQuestionnaire = typeof questionnaires.$inferInsert;
export type QuestionnaireVersion = typeof questionnaireVersions.$inferSelect;
export type QuestionnaireCaseType = typeof questionnaireCaseTypes.$inferSelect;
export type QuestionnaireVersionCaseType =
  typeof questionnaireVersionCaseTypes.$inferSelect;
export type QuestionnaireSection = typeof questionnaireSections.$inferSelect;
export type QuestionnaireQuestion = typeof questionnaireQuestions.$inferSelect;
export type QuestionnaireQuestionOption =
  typeof questionnaireQuestionOptions.$inferSelect;
export type QuestionnaireLogicRule = typeof questionnaireLogicRules.$inferSelect;
export type QuestionnaireSend = typeof questionnaireSends.$inferSelect;
export type QuestionnaireResponse = typeof questionnaireResponses.$inferSelect;
export type QuestionnaireAnswer = typeof questionnaireAnswers.$inferSelect;
export type QuestionnaireResponseFile =
  typeof questionnaireResponseFiles.$inferSelect;
