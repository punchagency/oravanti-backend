import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const aiSystemConfig = pgTable('ai_system_config', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  organizationId:                text('organization_id').notNull().unique().references(() => organization.id),
  isActive:              boolean('is_active').notNull().default(true),
  crossCheckingEnabled:  boolean('cross_checking_enabled').notNull().default(true),
  inaValidationActive:   boolean('ina_validation_active').notNull().default(true),
  realtimeAnalysis:      boolean('realtime_analysis').notNull().default(true),
  updatedAt:             timestamp('updated_at').notNull().defaultNow(),
});

export type AiSystemConfig = typeof aiSystemConfig.$inferSelect;
export type NewAiSystemConfig = typeof aiSystemConfig.$inferInsert;
