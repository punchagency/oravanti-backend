import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const admins = pgTable('admins', {
  id:        uuid('id').primaryKey().defaultRandom(),
  organizationId:    text('organization_id').notNull().unique().references(() => organization.id),
  userId:    text('user_id').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName:  text('last_name').notNull(),
  email:     text('email').notNull().unique(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
