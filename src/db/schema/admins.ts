import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const admins = pgTable('admins', {
  id:        uuid('id').primaryKey().defaultRandom(),
  firmId:    uuid('firm_id').notNull().references(() => firms.id),
  userId:    uuid('user_id').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName:  text('last_name').notNull(),
  email:     text('email').notNull().unique(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
