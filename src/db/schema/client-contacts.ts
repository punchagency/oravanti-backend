import { pgTable, uuid, text, date, boolean, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { clients } from './clients';
import { leads } from './leads';

export const contactRoleEnum = pgEnum('contact_role', [
  'primary',
  'representative',
  'spouse',
  'dependent',
  'authorized_rep',
]);

export const clientContacts = pgTable('client_contacts', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  clientId:       uuid('client_id').references(() => clients.id),
  leadId:         uuid('lead_id').references(() => leads.id),
  role:           contactRoleEnum('role').notNull().default('primary'),
  isPrimary:      boolean('is_primary').notNull().default(false),
  firstName:      text('first_name').notNull(),
  middleName:     text('middle_name'),
  lastName:       text('last_name').notNull(),
  secondLastName: text('second_last_name'),
  thirdLastName:  text('third_last_name'),
  fourthLastName: text('fourth_last_name'),
  email:          text('email').notNull(),
  phone:          text('phone'),
  dateOfBirth:    date('date_of_birth'),
  nationality:    text('nationality'),
  countryOfOrigin: text('country_of_origin'),
  passportNumber: text('passport_number'),
  currentAddress: text('current_address'),
  languagePreference: text('language_preference'),
  portalUserId:   text('portal_user_id'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
},
(t) => [
  unique('client_contacts_org_email_unique').on(t.organizationId, t.email),
]);

export type ClientContact    = typeof clientContacts.$inferSelect;
export type NewClientContact = typeof clientContacts.$inferInsert;
