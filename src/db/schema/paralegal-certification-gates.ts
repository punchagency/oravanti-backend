import { pgTable, uuid, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const paralegalActionEnum = pgEnum('paralegal_action', [
  'create_basic_forms',
  'submit_for_review',
  'handle_complex_cases',
  'uscis_filing_prep',
  'waiver_applications',
]);

export const paralegalCertificationGates = pgTable(
  'paralegal_certification_gates',
  {
    id:                     uuid('id').primaryKey().defaultRandom(),
    firmId:                 uuid('firm_id').notNull().references(() => firms.id),
    action:                 paralegalActionEnum('action').notNull(),
    actionLabel:            text('action_label').notNull(),
    requiredCertifications: text('required_certifications').array().notNull().default([]),
    updatedAt:              timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.action)]
);

export type ParalegalCertificationGate = typeof paralegalCertificationGates.$inferSelect;
export type NewParalegalCertificationGate = typeof paralegalCertificationGates.$inferInsert;
