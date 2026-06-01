import { pgTable, uuid, text, numeric, date, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { filingTypeEnum } from './enums';
import { organization } from './auth-schema';

export const contractorStatusEnum = pgEnum('contractor_status', ['active', 'inactive', 'pending']);

export const contractors = pgTable('contractors', {
  id:     uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  specialization: filingTypeEnum('specialization'),
  status: contractorStatusEnum('status').notNull().default('pending'),
  rate: numeric('rate', { precision: 10, scale: 2 }),
  contractStart: date('contract_start'),
  contractEnd: date('contract_end'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Contractor = typeof contractors.$inferSelect;
export type NewContractor = typeof contractors.$inferInsert;
