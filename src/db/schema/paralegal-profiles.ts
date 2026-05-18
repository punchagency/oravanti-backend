import { pgTable, uuid, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { firms } from './firm-info';

export const paralegalTypeEnum = pgEnum('paralegal_type', ['junior', 'senior']);

export const paralegalProfiles = pgTable('paralegal_profiles', {
  id:      uuid('id').primaryKey().defaultRandom(),
  firmId:  uuid('firm_id').notNull().references(() => firms.id),
  staffId: uuid('staff_id').notNull().unique().references(() => staff.id, { onDelete: 'cascade' }),
  type: paralegalTypeEnum('type').notNull().default('junior'),
  isCertified: boolean('is_certified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ParalegalProfile = typeof paralegalProfiles.$inferSelect;
export type NewParalegalProfile = typeof paralegalProfiles.$inferInsert;
