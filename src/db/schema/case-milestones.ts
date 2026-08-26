import { date, index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * What the agency did, and when.
 *
 * Distinct from `audit_events`, which records what the *firm* did: "USCIS
 * scheduled biometrics for 14 Oct" is a fact about the case; "Dara recorded
 * that USCIS scheduled biometrics" is the audit event. The recorder writes
 * both.
 *
 * This is also the chronology a mandamus complaint's factual background is
 * built from, which is why each row carries the notice it was read off rather
 * than just a date.
 *
 * ─── Why this is not `case_events` returning ────────────────────────────────
 *
 * `case_events` was deliberately deleted (see `cases/case-events.service.ts`)
 * because it duplicated the firm-activity vocabulary that now lives in
 * `audit_events`, and because its cascading `case_id` meant deleting a matter
 * destroyed its history. Two rules carried over from that:
 *
 *   1. `caseId` has NO foreign key and NO cascade. Deleting a matter must not
 *      delete the record of what the government did to it.
 *   2. Corrections do not get a bespoke history mechanism here. One row per
 *      (case, milestone), upserted; the correction trail is
 *      `case.milestone_corrected` in `audit_events`. Building a second
 *      append-only log beside the audit trail is exactly the duplication that
 *      deletion was undoing.
 */

/**
 * One value per due-date anchor that had no backing field.
 *
 * Deliberately only these six: `oath_ceremony_date` is N-400 and out of scope
 * for this phase, and a value nothing anchors to would be a column nothing
 * reads. Extend by appending when a template step needs it.
 */
export const caseMilestoneEnum = pgEnum("case_milestone", [
  "receipt",                 // I-797C receipt notice issued; the priority date locks here
  "biometrics_appointment",  // ASC appointment date
  "interview_scheduled",     // field-office interview date
  "decision",                // adjudication decision date
  "card_valid_to",           // EAD/AP combo card expiry
  "green_card_expiration",   // 10-year, or 2-year where residence is conditional
]);

export type CaseMilestone = (typeof caseMilestoneEnum.enumValues)[number];

export const caseMilestones = pgTable(
  "case_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    /** No FK by design — see the note above. */
    caseId: uuid("case_id").notNull(),
    milestone: caseMilestoneEnum("milestone").notNull(),
    occurredOn: date("occurred_on").notNull(),
    /** The I-797C (or other notice) this date was read off, so it can be checked. */
    noticeNumber: text("notice_number"),
    note: text("note"),
    recordedByStaffId: uuid("recorded_by_staff_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("case_milestones_case_milestone_unique").on(t.caseId, t.milestone),
    index("case_milestones_case_idx").on(t.caseId),
  ],
);

export type CaseMilestoneRow = typeof caseMilestones.$inferSelect;
export type NewCaseMilestoneRow = typeof caseMilestones.$inferInsert;
