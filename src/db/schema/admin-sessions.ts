import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const adminSessions = pgTable('admin_sessions', {
  id:         uuid('id').primaryKey().defaultRandom(),
  organizationId:     text('organization_id').notNull().references(() => organization.id),
  userId:     text('user_id').notNull(),
  deviceInfo: text('device_info').notNull(),
  ipAddress:  text('ip_address').notNull(),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
});

export type AdminSession = typeof adminSessions.$inferSelect;
export type NewAdminSession = typeof adminSessions.$inferInsert;
