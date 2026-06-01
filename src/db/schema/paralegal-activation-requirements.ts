import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { certifications } from './certifications';
import { organization } from './auth-schema';

export const paralegalActivationRequirements = pgTable(
  'paralegal_activation_requirements',
  {
    organizationId:            text('organization_id').notNull().references(() => organization.id),
    certificationCode: text('certification_code').notNull().references(() => certifications.code),
    addedAt:           timestamp('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.certificationCode] })]
);

export type ParalegalActivationRequirement = typeof paralegalActivationRequirements.$inferSelect;
