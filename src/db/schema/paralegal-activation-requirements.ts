import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { certifications } from './certifications';
import { firms } from './firm-info';

export const paralegalActivationRequirements = pgTable(
  'paralegal_activation_requirements',
  {
    firmId:            uuid('firm_id').notNull().references(() => firms.id),
    certificationCode: text('certification_code').notNull().references(() => certifications.code),
    addedAt:           timestamp('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.firmId, t.certificationCode] })]
);

export type ParalegalActivationRequirement = typeof paralegalActivationRequirements.$inferSelect;
