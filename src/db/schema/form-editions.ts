import { date, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * Which edition of a USCIS form is acceptable on a given filing date.
 *
 * Global reference data, platform-maintained and not tenant-scoped — same
 * category as `uscis_processing_time_reference` and `practice_areas`.
 *
 * USCIS prints an edition date at the foot of every page and rejects filings
 * made on a superseded edition. Some transitions come with a grace period in
 * which two editions are both accepted; others take effect with none at all.
 * Modelling each edition as a half-open acceptance window covers both without a
 * special case: overlapping windows mean "either edition is fine", disjoint
 * windows mean the change was immediate, and a null `acceptedUntil` marks the
 * edition currently in force.
 *
 * `formCode` is deliberately free text rather than the `filing_type` enum: a
 * package carries forms that are never themselves a filing type (I-130A, I-864,
 * I-693), and this table is about paper, not about what kind of case it is.
 */
export const formEditions = pgTable(
  "form_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "I-485", "I-130A", "I-864". */
    formCode: text("form_code").notNull(),
    /** The date printed on the form, e.g. "2026-09-18" for the 09/18/26 edition. */
    editionDate: date("edition_date").notNull(),
    /** First filing date this edition may be used on. */
    acceptedFrom: date("accepted_from").notNull(),
    /** Last filing date this edition may be used on; null while it is current. */
    acceptedUntil: date("accepted_until"),
    /** The USCIS page or alert this row was read from, so it can be re-verified. */
    sourceUrl: text("source_url"),
    /** When a human last checked this row against uscis.gov. */
    verifiedOn: date("verified_on"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("form_editions_form_idx").on(t.formCode),
    // The seed upserts on this pair; without it a re-run duplicates rows.
    unique("form_editions_form_edition_unique").on(t.formCode, t.editionDate),
  ],
);

export type FormEdition = typeof formEditions.$inferSelect;
export type NewFormEdition = typeof formEditions.$inferInsert;
