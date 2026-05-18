import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const adminSessions = pgTable('admin_sessions', {
  id:         uuid('id').primaryKey().defaultRandom(),
  firmId:     uuid('firm_id').notNull().references(() => firms.id),
  userId:     uuid('user_id').notNull(),
  deviceInfo: text('device_info').notNull(),
  ipAddress:  text('ip_address').notNull(),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
});

export type AdminSession = typeof adminSessions.$inferSelect;
export type NewAdminSession = typeof adminSessions.$inferInsert;
