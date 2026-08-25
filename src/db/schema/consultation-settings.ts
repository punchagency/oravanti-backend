import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

export const consultationFeeStructureEnum = pgEnum(
  "consultation_fee_structure",
  ["flat", "custom_per_case_type", "waived_if_retainer"],
);

/**
 * WHEN the consultation fee is collected, as distinct from what it costs.
 *
 * The default reproduces the behaviour every firm had before this column
 * existed: the invoice is due the day it is raised and the lead cannot pick a
 * slot until it is settled. Nobody's flow changes until an admin opts in.
 */
export const consultationFeeScheduleEnum = pgEnum(
  "consultation_fee_schedule",
  [
    // Due immediately; no slots offered until the full amount is paid.
    "full_upfront",
    // A deposit clears the booking gate; the balance is due after the call.
    "partial_upfront",
    // Book freely; the fee is invoiced when the consultation completes.
    "after_consultation",
  ],
);

/**
 * What happens to the fee when the lead does not turn up.
 *
 * `forfeit` is the default because it is what the code already did — a paid
 * no-show kept the money and an unpaid one stayed on the books. Naming it makes
 * that a decision rather than an oversight.
 */
export const consultationNoShowPolicyEnum = pgEnum(
  "consultation_no_show_policy",
  [
    // Paid: the firm keeps it, the slot was held. Unpaid: the debt stands.
    "forfeit",
    // Paid: refunded in full. Unpaid: the invoice is voided.
    "refund",
    // Neither. Raises a task so a human decides case by case.
    "decide",
  ],
);

/**
 * How the deposit's balance due date is decided.
 *
 * `fixed` applies the same number of days to every consultation; `custom` makes
 * that number the default and lets whoever schedules the consultation change it.
 * There is no per-case-type option because there is no per-case-type storage
 * anywhere in the system — `custom_per_case_type` on the fee structure names a
 * lookup that does not exist either, and is a per-consultation override in fact.
 */
export const consultationBalanceDueModeEnum = pgEnum(
  "consultation_balance_due_mode",
  ["fixed", "custom"],
);

export const consultationSettings = pgTable("consultation_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  chargesFee: boolean("charges_fee").notNull().default(false),
  defaultAmount: numeric("default_amount", { precision: 10, scale: 2 }),
  feeStructure: consultationFeeStructureEnum("fee_structure"),
  waiverWindowDays: integer("waiver_window_days"),
  feeSchedule: consultationFeeScheduleEnum("fee_schedule")
    .notNull()
    .default("full_upfront"),
  /**
   * The deposit, as a percentage of the whole fee.
   *
   * A percentage rather than an amount so one setting stays correct as the fee
   * moves: `custom_per_case_type` and the emergency multiplier both change the
   * number it applies to, and a fixed deposit would silently become the entire
   * fee on a cheap consultation.
   */
  upfrontPercent: integer("upfront_percent"),
  /**
   * When the deposit's balance falls due, counted in days FROM THE
   * CONSULTATION — the balance is owed for a call that has happened, so the
   * call is what it hangs off.
   *
   * Both columns are null unless the firm collects a deposit, mirroring
   * `upfrontPercent`. Before this the balance was due on `scheduledAt`, which
   * is still null at booking time for every lead-driven consultation, so it
   * silently fell back to the standard 14-day terms and the settings copy
   * promising "due when the consultation happens" was true only for urgent and
   * instant bookings.
   */
  balanceDueMode: consultationBalanceDueModeEnum("balance_due_mode"),
  balanceDueDays: integer("balance_due_days"),
  noShowPolicy: consultationNoShowPolicyEnum("no_show_policy")
    .notNull()
    .default("forfeit"),
  // IANA timezone the firm operates in (e.g. "America/New_York"). Business logic
  // (office hours, scheduling, deadlines, reporting) is computed in this zone.
  timezone: text("timezone").notNull().default("UTC"),
  // BCP-47 language tag ("en", "fr") the firm reads its own dashboards in.
  //
  // Firm-level, NOT lead-level: `leads.language` governs what the *client*
  // receives, whereas this governs staff-facing prose — a French-speaking
  // lead's AI review findings still render in English for a US firm.
  //
  // BCP-47 deliberately, rather than a fourth spelling of "english": the
  // codebase already carries `leads.language` (free text "english"),
  // `client_contacts.languagePreference` (enum "en") and
  // `questionnaires.language` (text "english").
  language: text("language").notNull().default("en"),
  // The firm-wide SMS master switch, read by resolveChannelDecision on every
  // SMS send. Off means no text message leaves the system for this firm, on any
  // channel-picker or event, transactional or not.
  //
  // Defaults false and stays false until an admin turns it on: SMS costs money
  // per message and reaches a phone rather than an inbox, so it is an opt-in.
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // 100 would mean `full_upfront` by a longer route and 0 would mean
  // `after_consultation`; both are already their own schedule, so a deposit
  // that equals neither end is the only thing this column can usefully say.
  check(
    "consultation_settings_upfront_percent_range",
    sql`${table.upfrontPercent} IS NULL OR (${table.upfrontPercent} > 0 AND ${table.upfrontPercent} < 100)`,
  ),
  // A deposit only means something on the schedule that collects one.
  check(
    "consultation_settings_upfront_percent_matches_schedule",
    sql`(${table.feeSchedule} = 'partial_upfront') = (${table.upfrontPercent} IS NOT NULL)`,
  ),
  // The mode and the day count are one setting in two columns; neither says
  // anything alone. Same biconditional shape as the deposit above.
  check(
    "consultation_settings_balance_due_pair",
    sql`(${table.balanceDueMode} IS NULL) = (${table.balanceDueDays} IS NULL)`,
  ),
  // A balance falls due after the consultation, never before it, and a firm
  // waiting more than a quarter for it has a collections problem rather than a
  // settings one.
  check(
    "consultation_settings_balance_due_days_range",
    sql`${table.balanceDueDays} IS NULL OR (${table.balanceDueDays} >= 0 AND ${table.balanceDueDays} <= 90)`,
  ),
  // And it only means anything on the schedule that produces a balance.
  check(
    "consultation_settings_balance_due_matches_schedule",
    sql`${table.balanceDueMode} IS NULL OR ${table.feeSchedule} = 'partial_upfront'`,
  ),
]);

export type ConsultationSettings = typeof consultationSettings.$inferSelect;
export type NewConsultationSettings = typeof consultationSettings.$inferInsert;
