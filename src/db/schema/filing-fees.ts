import { date, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * What USCIS charges for a form, and when that price applied.
 *
 * Global reference data with no `organizationId` — the fee schedule is the
 * government's, identical for every firm — so it sits in RLS_EXEMPTIONS
 * alongside `form_editions` and `visa_bulletin_cutoffs`.
 *
 * ─── Why a table and not constants ──────────────────────────────────────────
 *
 * The source document quoted the I-765 at $470/$520. Filed concurrently with a
 * pending I-485 it is $260 — the single most commonly bundled form in the whole
 * practice area, misquoted by a factor of two. A figure in code gets copied,
 * goes stale, and has no effective date, so nothing can tell you what a matter
 * filed last March should have paid.
 *
 * Rows are therefore versioned by date and looked up against the matter's own
 * filing date, so a case keeps quoting the fee that actually applied to it.
 */

/**
 * What distinguishes two prices for the same form.
 *
 * `standalone` vs `with_pending_i485` is the whole reason this column exists —
 * the same I-765 costs $520 or $260 depending only on what it is filed with.
 */
export const feeContextEnum = pgEnum("filing_fee_context", [
  "standalone",
  "with_pending_i485",
]);

/**
 * Online and paper filing are priced differently for some forms and identical
 * for others. `any` means the form has one price however it is filed.
 */
export const filingMethodEnum = pgEnum("filing_method", ["online", "paper", "any"]);

export const filingFeeSchedule = pgTable(
  "filing_fee_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Free text, e.g. "I-485". Matches `form_editions.form_code`. */
    formCode: text("form_code").notNull(),

    filingMethod: filingMethodEnum("filing_method").notNull().default("any"),
    context: feeContextEnum("context").notNull().default("standalone"),

    /**
     * Cents, not dollars. Money in a float is a bug waiting for a rounding
     * error, and these figures are quoted to clients.
     */
    amountCents: integer("amount_cents").notNull(),

    effectiveFrom: date("effective_from").notNull(),
    /** Null = this is the price in force now. */
    effectiveTo: date("effective_to"),

    notes: text("notes"),
    sourceUrl: text("source_url"),
    /** When a person last checked this row against the source. */
    verifiedOn: date("verified_on"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One price per form/method/context/start-date. Re-seeding updates in place
    // rather than stacking two prices a lookup would then pick between.
    unique("filing_fee_schedule_form_method_context_from_unique").on(
      t.formCode,
      t.filingMethod,
      t.context,
      t.effectiveFrom,
    ),
    index("filing_fee_schedule_form_idx").on(t.formCode),
  ],
);

export type FilingFee = typeof filingFeeSchedule.$inferSelect;
export type NewFilingFee = typeof filingFeeSchedule.$inferInsert;

/**
 * 125% of the HHS poverty guidelines — the I-864 income threshold.
 *
 * Keyed by jurisdiction because Alaska and Hawaii have their own tables and run
 * materially higher. A single national table would under-state the requirement
 * for an AK or HI sponsor, and an I-864 filed below the threshold is an RFE at
 * best.
 */
export const povertyGuidelines = pgTable(
  "poverty_guidelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The guideline year, e.g. 2026. */
    year: integer("year").notNull(),

    /**
     * `"48"` for the 48 contiguous states + DC, or the two-letter state code for
     * Alaska (`AK`) and Hawaii (`HI`).
     */
    jurisdiction: text("jurisdiction").notNull(),

    householdSize: integer("household_size").notNull(),

    /**
     * The 125% figure in cents, which is the number the I-864 is actually
     * measured against.
     */
    thresholdCents: integer("threshold_cents").notNull(),

    /**
     * The 100% figure, which applies where the sponsor is active-duty military
     * sponsoring a spouse or child. Stored alongside rather than derived, because
     * the published tables round each percentage independently.
     */
    militaryThresholdCents: integer("military_threshold_cents").notNull(),

    /** Added per person beyond the largest published household size. */
    perAdditionalPersonCents: integer("per_additional_person_cents").notNull(),

    effectiveFrom: date("effective_from").notNull(),
    sourceUrl: text("source_url"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("poverty_guidelines_year_jurisdiction_size_unique").on(
      t.year,
      t.jurisdiction,
      t.householdSize,
    ),
  ],
);

export type PovertyGuideline = typeof povertyGuidelines.$inferSelect;
