import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const firms = pgTable('firms', {
  id:        uuid('id').primaryKey().defaultRandom(),
  firmName:  text('firm_name').notNull(),
  firmEmail: text('firm_email').notNull(),
  firmPhone: text('firm_phone'),
  address:   text('address'),
  city:      text('city'),
  state:     text('state'),
  zipCode:   text('zip_code'),
  website:   text('website'),
  taxId:     text('tax_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Firm = typeof firms.$inferSelect;
export type NewFirm = typeof firms.$inferInsert;
