import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { user } from "./auth-schema";
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

/**
 * How a case relates to its `parentCaseId`. Only `mandamus` is used by v1
 * content (see `.claude/workflows/05-immigration-template.md`); `appeal` and
 * `related_matter` are included now because they're the obvious next two and
 * adding enum values later is exactly as cheap as adding them now, whereas a
 * bare boolean "isLinkedCase" would need reshaping.
 */
export const caseRelationTypeEnum = pgEnum("case_relation_type", [
  "mandamus",
  "appeal",
  "related_matter",
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
    .references(() => clients.id, { onDelete: "cascade" }),

  // Direct link to client's user account (for client portal RLS)
  clientUserId: text("client_user_id").references(() => user.id, {
    onDelete: "set null",
  }),

  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),

  // Mandamus/appeal/related-matter linking. `onDelete: 'set null'`, not
  // `cascade`: a mandamus case is meaningful on its own even if the parent case
  // row is later removed — unlike `leadId` above, where a case is the lead's
  // continuation, not an independent record once it exists. `(): AnyPgColumn =>`
  // is Drizzle's required typing form for a self-referential FK — a plain arrow
  // function reference errors on circular type inference.
  parentCaseId: uuid("parent_case_id").references((): AnyPgColumn => cases.id, { onDelete: "set null" }),
  relationType: caseRelationTypeEnum("relation_type"),

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

// =========================================================================
// CASE ASSIGNMENTS (Client & Contractor Junction)
// =========================================================================

/**
 * Case Assignments: Links users (clients/contractors) to cases.
 * Used for RLS user-ownership policies — a user sees cases they're assigned to.
 */
export const caseAssignmentRoleEnum = pgEnum("case_assignment_role", [
  "client",
  "contractor",
]);

export const caseAssignments = pgTable(
  "case_assignments",
  {
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: caseAssignmentRoleEnum("role").notNull(),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.caseId, t.userId, t.role] }),
    index("case_assignments_user_idx").on(t.userId),
  ],
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
export type CaseRecordNote = typeof caseRecordNotes.$inferSelect;

export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
export type CaseToCertification = typeof casesToCertifications.$inferSelect;

export type CaseAssignment = typeof caseAssignments.$inferSelect;
export type NewCaseAssignment = typeof caseAssignments.$inferInsert;
export type CaseAssignmentRole = (typeof caseAssignmentRoleEnum.enumValues)[number];
