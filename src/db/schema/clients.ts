import { pgTable, uuid, text, date, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const clientStatusEnum = pgEnum('client_status', ['active', 'inactive', 'pending']);

export const clients = pgTable('clients', {
  id:              uuid('id').primaryKey().defaultRandom(),
  firmId:          uuid('firm_id').notNull().references(() => firms.id),
  userId:          uuid('user_id'),
  firstName:       text('first_name').notNull(),
  lastName:        text('last_name').notNull(),
  email:           text('email').notNull().unique(),
  phone:           text('phone').notNull(),
  dateOfBirth:     date('date_of_birth').notNull(),
  nationality:     text('nationality').notNull(),
  countryOfOrigin: text('country_of_origin').notNull(),
  passportNumber:  text('passport_number'),
  currentAddress:  text('current_address').notNull(),
  status:          clientStatusEnum('status').notNull().default('active'),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
});

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
