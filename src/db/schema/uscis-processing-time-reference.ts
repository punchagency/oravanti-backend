import { date, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * USCIS-published median processing times, by form and field office — the
 * denominator for mandamus candidacy's `delayRatio` (see
 * `computeMandamusCandidacy`, src/modules/workflow). Global reference data,
 * platform-maintained, not tenant-scoped — same category as `practice_areas`.
 *
 * Versioned by `effectiveDate` rather than updated in place: these figures move
 * monthly per USCIS's own published data, and a historical case's candidacy
 * score should be computable against the figure that was current when it was
 * checked, not silently rewritten by a later refresh.
 */
export const uscisProcessingTimeReference = pgTable("uscis_processing_time_reference", {
  id: uuid("id").primaryKey().defaultRandom(),
  formType: text("form_type").notNull(), // matches filing_type enum values
  fieldOffice: text("field_office").notNull(),
  medianDays: integer("median_days").notNull(),
  effectiveDate: date("effective_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UscisProcessingTimeReference = typeof uscisProcessingTimeReference.$inferSelect;
export type NewUscisProcessingTimeReference = typeof uscisProcessingTimeReference.$inferInsert;
