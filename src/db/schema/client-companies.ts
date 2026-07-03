import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { clients } from './clients';

export const companyTypeEnum = pgEnum('company_type', [
  'llc',
  'corporation',
  's_corp',
  'partnership',
  'sole_proprietorship',
  'non_profit',
  'government',
  'other',
]);

export const clientCompanies = pgTable('client_companies', {
  id:               uuid('id').primaryKey().defaultRandom(),
  organizationId:   text('organization_id').notNull().references(() => organization.id),
  clientId:         uuid('client_id').notNull().unique().references(() => clients.id),
  companyName:      text('company_name').notNull(),
  companyType:      companyTypeEnum('company_type').notNull(),
  ein:              text('ein'),
  industry:         text('industry'),
  numberOfEmployees: integer('number_of_employees'),
  address:          text('address').notNull(),
  city:             text('city').notNull(),
  state:            text('state').notNull(),
  zipCode:          text('zip_code'),
  country:          text('country').notNull(),
  phone:            text('phone'),
  website:          text('website'),
  createdAt:        timestamp('created_at').notNull().defaultNow(),
  updatedAt:        timestamp('updated_at').notNull().defaultNow(),
});

export type ClientCompany    = typeof clientCompanies.$inferSelect;
export type NewClientCompany = typeof clientCompanies.$inferInsert;
