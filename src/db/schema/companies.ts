import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

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

export const companyStatusEnum = pgEnum('company_status', ['active', 'inactive', 'dissolved']);

export const companies = pgTable('companies', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  firmId:               uuid('firm_id').notNull().references(() => firms.id),
  companyName:          text('company_name').notNull(),
  companyType:          companyTypeEnum('company_type').notNull(),
  ein:                  text('ein'),
  industry:             text('industry'),
  numberOfEmployees:    integer('number_of_employees'),
  address:              text('address').notNull(),
  city:                 text('city').notNull(),
  state:                text('state').notNull(),
  zipCode:              text('zip_code'),
  country:              text('country').notNull(),
  phone:                text('phone'),
  website:              text('website'),
  primaryContactName:   text('primary_contact_name'),
  primaryContactEmail:  text('primary_contact_email'),
  primaryContactPhone:  text('primary_contact_phone'),
  status:               companyStatusEnum('status').notNull().default('active'),
  createdAt:            timestamp('created_at').notNull().defaultNow(),
  updatedAt:            timestamp('updated_at').notNull().defaultNow(),
});

export type Company    = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
