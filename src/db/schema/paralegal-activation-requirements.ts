import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { certifications } from './cases';
import { organization } from './auth-schema';

export const paralegalActivationRequirements = pgTable(
  'paralegal_activation_requirements',
  {
    organizationId:      text('organization_id').notNull().references(() => organization.id),
    certificationId: uuid('certification_id').notNull().references(() => certifications.id),
    addedAt:             timestamp('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.certificationId] })]
);

export type ParalegalActivationRequirement = typeof paralegalActivationRequirements.$inferSelect;
