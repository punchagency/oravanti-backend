import { pgTable, uuid, text, date, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { companies } from './companies';

export const clientTypeEnum  = pgEnum('client_type',   ['individual', 'company_representative']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'inactive', 'pending']);

export const clients = pgTable('clients', {
  id:              uuid('id').primaryKey().defaultRandom(),
  organizationId:          text('organization_id').notNull().references(() => organization.id),
  userId:          text('user_id'),
  firstName:       text('first_name').notNull(),
  middleName:      text('middle_name'),
  lastName:        text('last_name').notNull(),
  secondLastName:  text('second_last_name'),
  thirdLastName:   text('third_last_name'),
  fourthLastName:  text('fourth_last_name'),
  email:           text('email').notNull(),
  phone:           text('phone').notNull(),
  dateOfBirth:     date('date_of_birth').notNull(),
  nationality:     text('nationality').notNull(),
  countryOfOrigin: text('country_of_origin').notNull(),
  passportNumber:  text('passport_number'),
  currentAddress:  text('current_address').notNull(),
  clientType:      clientTypeEnum('client_type').notNull().default('individual'),
  companyId:       uuid('company_id').references(() => companies.id),
  status:          clientStatusEnum('status').notNull().default('active'),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
},
(t) => [
  unique('clients_firm_email_unique').on(t.organizationId, t.email),
]);

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
