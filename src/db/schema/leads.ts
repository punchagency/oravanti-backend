import { pgTable, uuid, text, timestamp, pgEnum, primaryKey, jsonb, index } from "drizzle-orm/pg-core";
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
  "pre_consultation",
  "post_consultation",
]);

/**
 * Every action that can be taken on a lead during intake. Written append-only
 * to `lead_events`; no code path updates or deletes an event.
 */
export const leadEventTypeEnum = pgEnum("lead_event_type", [
  "lead_received",
  "lead_updated",
  "stage_changed",
  "lead_assigned",
  "lead_archived",
  "lead_restored",
  "note_added",
  "conflict_check_run",
  "conflict_check_approved",
  "conflict_check_declined",
  "conflict_overridden",
  "questionnaire_sent",
  "questionnaire_response_received",
  "consultation_scheduled",
  "consultation_rescheduled",
  "consultation_cancelled",
  "consultation_completed",
  "fee_agreement_generated",
  "fee_agreement_sent",
  "fee_agreement_signed",
  "payment_received",
  "case_opened",
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

  // A lead has exactly one practice area and one case type. These were briefly
  // modelled as many-to-many junctions, but every code path only ever read or
  // wrote the first row (.limit(1)), and the junctions could not be projected
  // onto the scalar fields the clients read — so the practice-area and matter
  // type silently rendered empty everywhere. Back to plain columns.
  practiceAreaId: uuid("practice_area_id").references(() => practiceAreas.id),
  caseTypeId:     uuid("case_type_id").references(() => practiceAreaCaseTypes.id),

  // Compliance / Risk Mitigation checks
  intakeAdversePartyName:  text("intake_adverse_party_name"),
  intakeAdversePartyEmail: text("intake_adverse_party_email"),
  status:         leadStatusEnum("status").notNull().default("new"),
  pipelineStage:  leadPipelineStageEnum("pipeline_stage").notNull().default("lead_inbox"),

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

  // Ownership: who the lead is currently assigned to, and who assigned them.
  // Distinct from respondentId, which is a one-time stamp of who took the intake.
  assignedStaffId: uuid("assigned_staff_id").references(() => staff.id),
  assignedById:    uuid("assigned_by_id").references(() => staff.id),

  // Archival. Cleared on restore.
  archivedById:    uuid("archived_by_id").references(() => staff.id),
  archivedAt:      timestamp("archived_at"),
  archiveReason:   text("archive_reason"),

  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Lead Events: append-only audit trail of every action taken on a lead during
 * intake. Rows are never updated or deleted — the service exposes no such path,
 * and the read endpoint (GET /leads/:id/activity) is the only consumer.
 *
 * `actorNameSnapshot` is denormalised deliberately: the trail must still read
 * correctly after a staff member is removed.
 */
export const leadEvents = pgTable("lead_events", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  leadId:         uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  type:           leadEventTypeEnum("type").notNull(),

  // Null for lead-driven or system events (a lead paying via the booking link,
  // a webhook firing), and for backfilled events whose actor is unknowable.
  actorId:           uuid("actor_id").references(() => staff.id),
  actorNameSnapshot: text("actor_name_snapshot"),

  metadata:  jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_events_lead_id_created_at_idx").on(t.leadId, t.createdAt),
]);

/**
 * Lead Notes: append-only. There is deliberately no `updatedAt` and no update
 * or delete route — a note is a record of what someone said at a point in time,
 * so amending one would rewrite history. Corrections are made by adding a note.
 */
export const leadNotes = pgTable("lead_notes", {
  id:        uuid("id").primaryKey().defaultRandom(),
  leadId:    uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  authorId:  uuid("author_id").notNull().references(() => staff.id),
  type:      leadNoteTypeEnum("type").notNull().default("general"),
  content:   text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("lead_notes_lead_id_created_at_idx").on(t.leadId, t.createdAt),
]);

// leads_to_practice_areas / leads_to_case_types are gone: a lead's practice
// area and case type are columns on `leads` again. See the note on those
// columns above.

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadNote = typeof leadNotes.$inferSelect;
export type NewLeadNote = typeof leadNotes.$inferInsert;
export type LeadEvent = typeof leadEvents.$inferSelect;
export type NewLeadEvent = typeof leadEvents.$inferInsert;
export type LeadEventType = (typeof leadEventTypeEnum.enumValues)[number];
export type LeadNoteType = (typeof leadNoteTypeEnum.enumValues)[number];
