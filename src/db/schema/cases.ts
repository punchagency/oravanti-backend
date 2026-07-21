import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { clients } from "./clients";
import { leads } from "./leads";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { practiceAreas } from "./practice-areas";
import { staff } from "./staff";
import { team } from "./auth-schema";

// =========================================================================
// CASES & CERTIFICATIONS ENUMS
// =========================================================================

export const caseStatusEnum = pgEnum("case_status", [
  "pre_litigation",
  "active",
  "on_hold",
  "appeals",
  "closed",
  "pre_filing",
  "dismissed",
]);

export const caseCloseReasonEnum = pgEnum("case_close_reason", [
  "settled",
  "judgment_won",
  "judgment_lost",
  "dismissed_with_prejudice",
  "dismissed_without_prejudice",
  "withdrawn_by_client",
  "referred_out",
]);

export const casePriorityEnum = pgEnum("case_priority", [
  "low",
  "medium",
  "high",
  "urgent",
  "critical",
]);

export const caseBillingTypeEnum = pgEnum("case_billing_type", [
  "hourly",
  "flat_fee",
  "contingency",
  "pro_bono",
]);

export const caseNoteTypeEnum = pgEnum("case_note_type", [
  "client_communication",
  "internal_communication",
  "court_update",
  "evidence_log",
  "system_log",
  "general_update",
]);

export const certificationStatusEnum = pgEnum("certification_status", [
  "pending",
  "requested",
  "received",
  "expired",
  "not_required",
]);

export const caseEventTypeEnum = pgEnum("case_event_type", [
  "case_created",
  "case_updated",
  "case_deleted",
  "case_viewed",
  "case_status_changed",
  "case_priority_changed",
  "case_team_assigned",
  "case_team_reassigned",
  "case_note_created",
  "case_note_updated",
  "case_note_deleted",
  "case_note_pinned",
  "case_note_unpinned",
  "case_document_linked",
  "case_document_unlinked",
  "case_description_updated",
  "workflow_initialized",
  "module_activated",
  "step_assigned",
  "step_completed",
  "step_submitted_for_review",
  "step_approved",
  "step_rejected",
]);

// =========================================================================
// CASES & CERTIFICATIONS TABLES
// =========================================================================

/**
 * Cases/Matters Table: Substantive legal action instances.
 * Tied directly to an accountable legal team profile block rather than a single lawyer.
 */
export const cases = pgTable("cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  caseNumber: text("case_number").notNull().unique(), // Internal system generated billing code
  description: text("description").notNull(),

  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),

  practiceAreaId: uuid("practice_area_id")
    .notNull()
    .references(() => practiceAreas.id),
  caseTypeId: uuid("case_type_id")
    .notNull()
    .references(() => practiceAreaCaseTypes.id),

  status: caseStatusEnum("status").notNull().default("active"),
  priority: casePriorityEnum("priority").notNull().default("medium"),
  caseProgress: integer("case_progress").notNull().default(0),
  closeReason: caseCloseReasonEnum("close_reason"),

  // Hard Team Assignment metrics
  assignedTeamId: text("assigned_team_id").references(() => team.id),
  assignmentDate: timestamp("assignment_date").notNull().defaultNow(),
  reassignmentDate: timestamp("reassignment_date"),

  billingType: caseBillingTypeEnum("billing_type").notNull().default("hourly"),

  // Litigation Metadata vectors
  jurisdiction: text("jurisdiction"),
  assignedJudge: text("assigned_judge"),
  courtName: text("court_name"),
  courtDocketNumber: text("court_docket_number"), // Official court identification code

  // Chronological control blocks
  filingDate: date("filing_date"), // Nullable until official clerk processing confirmation
  estimatedCompletionDate: date("estimated_completion_date"),
  nextCourtDate: timestamp("next_court_date"),

  openedById: uuid("opened_by_id")
    .notNull()
    .references(() => staff.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Case Notes Table: Detailed chronologic narrative logs.
 * Supports secure visibility checks and dual-actor posting patterns (Staff Portal & Client Portal).
 */
export const caseRecordNotes = pgTable("case_record_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),

  // Mutually exclusive fields ensuring full structural data safety (Exactly one should be filled)
  authorStaffId: uuid("author_staff_id").references(() => staff.id),
  authorClientId: uuid("author_client_id").references(() => clients.id),

  type: caseNoteTypeEnum("type").notNull().default("internal_communication"),
  content: text("content").notNull(),

  // High-level access gate control (prevents internal details leaking into public client view spaces)
  isClientVisible: boolean("is_client_visible").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Certifications Table: System master taxonomy catalog for official declarations, certificates, and releases.
 */

export const certificationLevelEnum = pgEnum("certification_level", [
  "basic",
  "intermediate",
  "advanced",
  "expert",
]);
export const certifications = pgTable("certifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  name: text("name").notNull(), // e.g., "Certificate of Good Standing", "HIPAA Release"
  level: certificationLevelEnum("level").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Junction Table: Checklists detailing matching certification requirements across legal cases.
 */
export const casesToCertifications = pgTable(
  "cases_to_certifications",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    certificationId: uuid("certification_id")
      .notNull()
      .references(() => certifications.id, { onDelete: "cascade" }),

    status: certificationStatusEnum("status").notNull().default("pending"),
    notes: text("notes"), // e.g., "Awaiting wet signature processing by claimant"
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at"),
  },
  (t) => [{ pk:primaryKey({ columns: [t.caseId, t.certificationId] }) }],
);

// =========================================================================
// CASE EVENTS (Append-Only Audit Trail)
// =========================================================================

/**
 * Case Events: append-only audit trail for all case-level actions.
 * Mirrors the proven `lead_events` pattern for consistency.
 *
 * `actorNameSnapshot` is denormalised deliberately: the trail must still read
 * correctly after a staff member is removed.
 */
export const caseEvents = pgTable("case_events", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  caseId:         uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  eventType:      caseEventTypeEnum("event_type").notNull(),
  title:          text("title").notNull(),
  description:    text("description"),
  metadata:       jsonb("metadata"),
  actorId:        uuid("actor_id").references(() => staff.id),
  actorNameSnapshot: text("actor_name_snapshot"),
  ipAddress:      text("ip_address"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("case_events_case_id_created_at_idx").on(t.caseId, t.createdAt),
]);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
export type CaseRecordNote = typeof caseRecordNotes.$inferSelect;

export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
export type CaseToCertification = typeof casesToCertifications.$inferSelect;

export type CaseEvent = typeof caseEvents.$inferSelect;
export type NewCaseEvent = typeof caseEvents.$inferInsert;
export type CaseEventType = (typeof caseEventTypeEnum.enumValues)[number];
