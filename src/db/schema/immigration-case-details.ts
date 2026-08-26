import { boolean, date, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";

/**
 * Scope discipline: this table holds only fields the workflow/condition engine
 * actually branches on or anchors a due date to — the full form-field lists
 * (beneficiary aliases, address history, joint-sponsor income, etc.) belong to
 * the existing intake-questionnaire/document system, not here. See
 * `.claude/workflows/01-data-model.md §5`.
 */
export const filingTrackEnum = pgEnum("filing_track", ["concurrent", "sequential"]);
export const naturalizationTrackEnum = pgEnum("naturalization_track", [
  "general",
  "marriage_to_usc",
  "military",
]);

/*
 * The two inputs to § 1.1's eligibility table, and the category it yields.
 *
 * `filingTrack` was previously hand-set with nothing recording *why* it was set
 * that way. These are the facts it follows from; `deriveFilingEligibility`
 * (modules/workflow/filing-track.ts) is the table itself.
 *
 * Values are lower snake case to match every other enum here — that string is
 * what goes in the column, on the wire, and into a condition, so it has one
 * spelling everywhere.
 */
export const petitionerStatusEnum = pgEnum("petitioner_status", ["usc", "lpr"]);

export const relationshipCategoryEnum = pgEnum("relationship_category", [
  "spouse",
  "parent",
  "child_under_21",
  "unmarried_child_over_21",
  "married_child",
  "sibling",
]);

/** Immediate relative, or one of the five family preference categories. */
export const preferenceCategoryEnum = pgEnum("preference_category", [
  "ir",
  "f1",
  "f2a",
  "f2b",
  "f3",
  "f4",
]);

export const immigrationCaseDetails = pgTable("immigration_case_details", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().unique().references(() => cases.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id),

  /*
   * There is deliberately no `filingType` here. A matter files a package, not
   * a form — see `case-forms.ts`, which holds one row per form with its own
   * status, edition, fee, receipt number and filing date.
   */
  filingTrack: filingTrackEnum("filing_track"), // condition field — §1.1 of the source doc
  naturalizationTrack: naturalizationTrackEnum("naturalization_track"),

  /*
   * § 1.1 eligibility — the two inputs, and the two values derived from them.
   *
   * `filingTrack` above and `preferenceCategory` here are both computed by
   * `deriveFilingEligibility` (modules/workflow/filing-track.ts) from
   * `petitionerStatus` + `relationshipCategory`, and rewritten whenever either
   * input changes — but only while `filingTrackIsManual` is false. Same
   * computed-with-override shape as `priorityDateIsCurrent` below.
   */
  petitionerStatus: petitionerStatusEnum("petitioner_status"),
  relationshipCategory: relationshipCategoryEnum("relationship_category"),
  preferenceCategory: preferenceCategoryEnum("preference_category"),
  filingTrackIsManual: boolean("filing_track_is_manual").notNull().default(false),

  /*
   * Not a nicety. India, Mexico, the Philippines and China each get their own
   * Visa Bulletin column and can run years behind the worldwide cut-off, so
   * judging currency without it is wrong for a large share of the caseload.
   * ISO-3166 alpha-2, or the literal "worldwide" for everywhere else.
   */
  countryOfChargeability: text("country_of_chargeability"),

  lprDate: date("lpr_date"),
  eligibilityDate: date("eligibility_date"), // computed from lprDate + track rule, attorney-adjustable
  earliestFilingDate: date("earliest_filing_date"), // eligibilityDate - 90d, N-400 early-filing rule

  priorityDate: date("priority_date"),

  /*
   * Whether the priority date is current, i.e. a visa number is available and
   * the I-485 may now be filed. Condition field — see §1.2 of the source doc.
   *
   * Deliberately a stored attorney-set flag rather than something derived on
   * read from `priorityDate` and the Visa Bulletin. Three reasons:
   *
   *   - "Current" is a judgement call. It depends on the category, the chargeability
   *     country, and which of the bulletin's two charts USCIS accepts that month —
   *     and USCIS announces that choice separately from the bulletin itself.
   *   - Retrogression moves the cutoff backwards. A derived value would silently
   *     flip false and deactivate a module mid-matter; a stored one changes only
   *     when a person changes it, and leaves an audit row when they do.
   *   - Module activation must be reproducible. A condition that reads today's
   *     bulletin evaluates differently on every pass.
   *
   * The monthly bulletin poll proposes a change here; it never writes it.
   */
  priorityDateIsCurrent: boolean("priority_date_is_current").notNull().default(false),

  /*
   * The override latch. True once a person has set `priorityDateIsCurrent`
   * explicitly, after which the monthly Visa Bulletin job leaves this matter
   * alone. Clearing it hands the field back to the job.
   *
   * Kept as a separate column rather than inferred from an audit row because the
   * job has to filter on it in SQL, once a month, across every open matter.
   */
  priorityDateIsManual: boolean("priority_date_is_manual").notNull().default(false),

  /*
   * Milestone projections — the dates `due-date-resolver` anchors on.
   *
   * Written ONLY by `recordCaseMilestone`, never by a patch: `case_milestones`
   * is the source of truth and these are its denormalized read path, kept here
   * so resolving a due date stays a single-row lookup rather than a join. They
   * are excluded from `ImmigrationDetailsPatch` so nothing can write one
   * without also writing the milestone row, the calendar event and the audit
   * entry. See `workflow/case-milestone.service.ts`.
   *
   * `receiptDate` is the single date the priority date locks against — not to be
   * confused with a form's own receipt number, which lives on `case_forms`.
   */
  receiptDate: date("receipt_date"),
  biometricsAppointmentDate: date("biometrics_appointment_date"),
  interviewScheduledDate: date("interview_scheduled_date"),
  decisionDate: date("decision_date"),
  cardValidTo: date("card_valid_to"),
  greenCardExpirationDate: date("green_card_expiration_date"),

  gmcRiskFlag: boolean("gmc_risk_flag").notNull().default(false), // good-moral-character attorney-review flag
  mandamusEligible: boolean("mandamus_eligible"), // attorney-set only — never auto-decisioned, see caseRelationTypeEnum on cases.ts
  isConditionalResidence: boolean("is_conditional_residence").notNull().default(false), // marriage < 2yr at approval → 2yr card, triggers I-751

  /*
   * § 1.5 pitfall inputs.
   *
   * The scope rule at the top of this file says the table holds only what the
   * engine branches on or anchors a due date to. These are the third case, and
   * the rule is widened rather than bent: a § 1.5 validation rule reads them.
   * They earn their place the same way — each one is read by a named rule in
   * `aos-validation.service.ts`, and a field no rule reads does not belong here.
   *
   * All are nullable. Every rule treats a missing input as "cannot judge" and
   * says nothing, rather than warning on an absence.
   */

  /**
   * Trips taken or planned while the I-485 is pending.
   *
   * Leaving the U.S. without advance parole abandons the application — but the
   * rule is a warning, not a block: a beneficiary in valid H or L status may
   * travel on that status without abandoning anything, and hard-blocking would
   * stop lawful travel.
   */
  travelWhilePending: jsonb("travel_while_pending")
    .$type<{ departureDate: string; returnDate: string | null; hadAdvanceParole: boolean }[]>()
    .notNull()
    .default([]),

  /** When the beneficiary's current nonimmigrant status runs out. */
  beneficiaryStatusExpirationDate: date("beneficiary_status_expiration_date"),

  /** First day worked for the sponsoring or any employer, for the EAD rule. */
  employmentStartDate: date("employment_start_date"),
  /** Independently work-authorized (H-1B, L-2, EAD already in hand). */
  hasWorkAuthorization: boolean("has_work_authorization").notNull().default(false),

  // I-864 inputs. Cents, not dollars — this figure is quoted to a client.
  sponsorIncomeCents: integer("sponsor_income_cents"),
  sponsorHouseholdSize: integer("sponsor_household_size"),
  /** Two-letter state code. Alaska and Hawaii have their own poverty tables. */
  sponsorState: text("sponsor_state"),
  sponsorIsActiveDutyMilitary: boolean("sponsor_is_active_duty_military").notNull().default(false),

  /**
   * The civil surgeon's signature date on the I-693.
   *
   * Since 11 Jun 2025 the I-693 has no fixed validity window — it is good for as
   * long as the application it was filed with is pending. So this is not a clock
   * to count down; it is how a form is tied to an application that may since have
   * died, which is the actual pitfall.
   */
  i693SignedDate: date("i693_signed_date"),

  // RFE tracking — the one anchor pair that feeds a dynamic hook (scheduleRfeReminders)
  // rather than a static template anchor, since the window (30/60/87 days) is only
  // known once the actual notice is logged.
  rfeIssuedDate: date("rfe_issued_date"),
  rfeDeadline: date("rfe_deadline"),

  // mandamus-litigation fields — populated only on the mandamus case's OWN row
  // (its own `cases` id, linked via parentCaseId, see cases.ts), not on the parent
  // AOS/N-400 row. FRCP 4(i) fixes the defendant set at exactly 3 — three named
  // columns, not a child table, same reasoning as PI's litigation-milestone fields
  // in personal-injury-case-details.ts.
  usAttorneyServedDate: date("us_attorney_served_date"),
  agServedDate: date("ag_served_date"),
  agencyHeadServedDate: date("agency_head_served_date"),
  // Set once a human confirms ALL THREE above are done (the "mark SERVED" action).
  // Stored directly rather than computed as MAX(3 dates) so `resolveDueDate` needs
  // no mandamus-specific branch — this is the `date_anchor` enum's
  // `service_completed_date` value, wired to an actual column.
  serviceCompletedDate: date("service_completed_date"),
  demandLetterSentDate: date("demand_letter_sent_date"),
  rulingDate: date("ruling_date"),
  // free text, not enum: small closed set but only read for display/reporting, no branching logic keys on it
  closureType: text("closure_type"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ImmigrationCaseDetails = typeof immigrationCaseDetails.$inferSelect;
export type NewImmigrationCaseDetails = typeof immigrationCaseDetails.$inferInsert;
