import { date, boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";

/**
 * Scope discipline: this table holds only fields the workflow/condition engine
 * actually branches on or anchors a due date to. See
 * `.claude/workflows/01-data-model.md §5`.
 */
export const defendantTypeEnum = pgEnum("defendant_type", ["private", "government_entity"]);

export const personalInjuryCaseDetails = pgTable("personal_injury_case_details", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().unique().references(() => cases.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id),

  incidentDate: date("incident_date").notNull(),
  defendantType: defendantTypeEnum("defendant_type").notNull().default("private"), // condition field
  isMinorPlaintiff: boolean("is_minor_plaintiff").notNull().default(false),

  statuteOfLimitationsDate: date("statute_of_limitations_date"), // computed, attorney-approved
  solTollingNotes: text("sol_tolling_notes"),
  governmentNoticeDeadline: date("government_notice_deadline"), // FTCA §768.28, government_entity only

  mmiDate: date("mmi_date"), // Maximum Medical Improvement
  mmiConfirmedBy: text("mmi_confirmed_by"),
  treatmentGapFlag: boolean("treatment_gap_flag").notNull().default(false),
  demandSentDate: date("demand_sent_date"),

  // litigation-phase milestones — paralegal-logged as each is reached, not
  // pre-computable at template time. Single-value fields (one tracked defendant,
  // one trial date) is a deliberate v1 scope choice: multi-defendant litigation
  // with independently staggered answer dates is real but rarer, and the source
  // doc's own workflow narration is a single litigation timeline throughout. If
  // multi-defendant staggered tracking is ever needed, it becomes its own small
  // `pi_case_defendants` child table — don't generalize for it now.
  defendantAnswerDate: date("defendant_answer_date"),
  msjFiledDate: date("msj_filed_date"),
  mediationScheduledDate: date("mediation_scheduled_date"),
  trialDate: date("trial_date"),
  verdictDate: date("verdict_date"),
  fundsReceivedDate: date("funds_received_date"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PersonalInjuryCaseDetails = typeof personalInjuryCaseDetails.$inferSelect;
export type NewPersonalInjuryCaseDetails = typeof personalInjuryCaseDetails.$inferInsert;
