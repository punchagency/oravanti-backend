import { pgTable, uuid, text, timestamp, pgEnum, primaryKey } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema"; 
import { practiceAreas } from "./practice-areas"; 
import { practiceAreaCaseTypes } from "./practice-area-case-types"; 
import { staff } from "./staff";

// =========================================================================
// LEADS ENUMS
// =========================================================================

export const leadEntityTypeEnum = pgEnum("lead_entity_type", ["individual", "company"]);

export const leadSourceEnum = pgEnum("lead_source", [
  "education_flywheel",
  "referral",
  "direct",
  "walk_in",
  "phone_enquiry",
  "client_portal",
]);

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "reviewed",
  "archived",
  "declined",   // Lead dropped due to conflict/issue
  "overridden", // Conflict flagged but manually bypassed by administrative review
  "converted",  // Terminal success state: Lead upgraded to full active client
]);

export const leadPipelineStageEnum = pgEnum("lead_pipeline_stage", [
  "lead_inbox",
  "conflict_check",
  "questionnaire",
  "consultation",
  "fee_agreement",
  "case_opening",
]);

export const leadNoteTypeEnum = pgEnum("lead_note_type", [
  "general",
  "phone_call",
  "email",
  "voicemail",
  "system_log",
]);

// =========================================================================
// LEADS TABLES
// =========================================================================

/**
 * Main Leads Table: Acts as a temporary workspace for legal opportunities.
 * Stores business opportunities before they are legally accepted as clients.
 */
export const leads = pgTable("leads", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  
  // Basic initial descriptive profiles
  firstName:      text("first_name").notNull(),
  lastName:       text("last_name").notNull(),
  email:          text("email").notNull(),
  phone:          text("phone"),
  entityType:     leadEntityTypeEnum("entity_type").notNull().default("individual"),
  source:         leadSourceEnum("source").notNull(),
  situationSummary: text("situation_summary"),
  
  // Compliance / Risk Mitigation checks
  intakeAdversePartyName:  text("intake_adverse_party_name"),
  intakeAdversePartyEmail: text("intake_adverse_party_email"),
  status:         leadStatusEnum("status").notNull().default("new"),
  pipelineStage: leadPipelineStageEnum("pipeline_stage").notNull().default("conflict_check"),

  // Preferred language for lead-facing communications (e.g. "english");
  // used when auto-sending the intake questionnaire.
  language:       text("language"),

  // Pipeline tracking references (unlinked raw UUIDs avoiding complex circular references)
  conflictCheckId:     uuid("conflict_check_id"),
  questionnaireSendId: uuid("questionnaire_send_id"),
  consultationId:      uuid("consultation_id"),
  feeAgreementId:      uuid("fee_agreement_id"),

  // Resolution linkage tracking
  clientId:          uuid("client_id"),
  convertedCaseId:   uuid("converted_case_id"),
  convertedAt:       timestamp("converted_at"),

  // Operational metrics tracker: Who initially managed the intake form/call
  respondentId:    uuid("respondent_id").references(() => staff.id),
  
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Lead Notes Table: Relational timeline tracking events during structural intake.
 */
export const leadNotes = pgTable("lead_notes", {
  id:        uuid("id").primaryKey().defaultRandom(),
  leadId:    uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  authorId:  uuid("author_id").notNull().references(() => staff.id),
  type:      leadNoteTypeEnum("type").notNull().default("general"),
  content:   text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Junction Table: Connects multiple Practice Areas to a single Lead.
 */
export const leadsToPracticeAreas = pgTable("leads_to_practice_areas", {
  leadId:         uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  practiceAreaId: uuid("practice_area_id").notNull().references(() => practiceAreas.id, { onDelete: "cascade" }),
}, (t) => [
  { pk: primaryKey({ columns: [t.leadId, t.practiceAreaId] }) }
]);

/**
 * Junction Table: Connects multiple granular Case Types to a single Lead.
 */
export const leadsToCaseTypes = pgTable("leads_to_case_types", {
  leadId:     uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  caseTypeId: uuid("case_type_id").notNull().references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),
}, (t) => [
  { pk: primaryKey({ columns: [t.leadId, t.caseTypeId] }) }
]);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadNote = typeof leadNotes.$inferSelect; 
