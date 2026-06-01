import { pgTable, uuid, text, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { organization } from './auth-schema';

export const paralegalTypeEnum = pgEnum('paralegal_type', ['junior', 'senior']);

export const paralegalProfiles = pgTable('paralegal_profiles', {
  id:      uuid('id').primaryKey().defaultRandom(),
  organizationId:  text('organization_id').notNull().references(() => organization.id),
  staffId: uuid('staff_id').notNull().unique().references(() => staff.id, { onDelete: 'cascade' }),
  type: paralegalTypeEnum('type').notNull().default('junior'),
  isCertified: boolean('is_certified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ParalegalProfile = typeof paralegalProfiles.$inferSelect;
export type NewParalegalProfile = typeof paralegalProfiles.$inferInsert;
