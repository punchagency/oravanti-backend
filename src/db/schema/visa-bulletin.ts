import { boolean, date, index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { preferenceCategoryEnum } from "./immigration-case-details";

/**
 * A month-by-month snapshot of the State Department's Visa Bulletin.
 *
 * Global reference data, identical for every firm — no `organizationId`, and an
 * RLS exemption alongside `form_editions`.
 *
 * ─── Why store it at all ────────────────────────────────────────────────────
 *
 * A priority date is "current" when it falls before the cut-off for that
 * category and country in the chart USCIS accepts that month. Every part of that
 * sentence moves: the cut-off changes monthly, it can move BACKWARDS
 * (retrogression), and which of the two charts governs is announced separately.
 * Deciding currency against a live fetch would mean the same case evaluating
 * differently on two consecutive materialization passes, with no record of why.
 *
 * So the bulletin is snapshotted, decisions are made against a stored month, and
 * the month a decision used stays readable afterwards.
 */

/**
 * The two charts a bulletin publishes.
 *
 * `final_action` is when a visa may actually be ISSUED. `dates_for_filing` is
 * the earlier, more generous chart saying when an application may be SUBMITTED.
 * USCIS announces which one it will accept for adjustment-of-status filings each
 * month, per category — and it is the filing chart that gates an I-485, which is
 * the decision this table exists to support.
 */
export const visaBulletinChartEnum = pgEnum("visa_bulletin_chart", [
  "final_action",
  "dates_for_filing",
]);

/**
 * One cut-off: a category, a chargeability area, a chart, for one month.
 *
 * `cutoffDate` is null when the cell is not a date. The bulletin prints two
 * non-date values and they mean opposite things, which is why `status` exists
 * rather than a sentinel date:
 *
 *   - `current` ("C") — no backlog at all; every priority date in this category
 *     is current. A null cut-off here means "everyone qualifies".
 *   - `unavailable` ("U") — no visas are available this month for anyone. A null
 *     cut-off here means "nobody qualifies".
 *
 * Collapsing those into one nullable date would make the two indistinguishable
 * and the comparison would silently pick a side.
 */
export const visaBulletinCutoffStatusEnum = pgEnum("visa_bulletin_cutoff_status", [
  "date",
  "current",
  "unavailable",
]);

export const visaBulletinCutoffs = pgTable(
  "visa_bulletin_cutoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** First of the month the bulletin governs, e.g. 2026-09-01. */
    bulletinMonth: date("bulletin_month").notNull(),

    category: preferenceCategoryEnum("category").notNull(),

    /**
     * ISO-3166 alpha-2, or the literal "worldwide".
     *
     * China, India, Mexico and the Philippines each get their own column in the
     * bulletin and can run years behind worldwide. Matching a case against the
     * worldwide row when it should use one of these is the single most likely
     * way to tell a client their date is current when it is not.
     */
    chargeabilityArea: text("chargeability_area").notNull(),

    chart: visaBulletinChartEnum("chart").notNull(),

    status: visaBulletinCutoffStatusEnum("status").notNull(),
    /** Set only when `status` is `date`. */
    cutoffDate: date("cutoff_date"),

    /**
     * Whether USCIS said to use THIS chart for family-sponsored adjustment
     * filings in this month.
     *
     * Stored per row rather than per month because the announcement is per
     * category: USCIS can accept the filing chart for one category and the final
     * action chart for another in the same month. Storing the cut-offs without
     * storing which chart governs makes the comparison meaningless — that is the
     * part most implementations get wrong.
     */
    governsAosFiling: boolean("governs_aos_filing").notNull().default(false),

    sourceUrl: text("source_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The natural key. Re-ingesting a month updates in place rather than
    // stacking duplicate cut-offs that a lookup would then pick between.
    unique("visa_bulletin_cutoffs_month_cat_area_chart_unique").on(
      t.bulletinMonth,
      t.category,
      t.chargeabilityArea,
      t.chart,
    ),
    index("visa_bulletin_cutoffs_month_idx").on(t.bulletinMonth),
  ],
);

export type VisaBulletinCutoff = typeof visaBulletinCutoffs.$inferSelect;
export type NewVisaBulletinCutoff = typeof visaBulletinCutoffs.$inferInsert;
