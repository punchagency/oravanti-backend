import { pgTable, uuid, numeric, date, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { staff } from './staff';
import { cases } from './cases';

export const timeEntries = pgTable('time_entries', {
  id:          uuid('id').primaryKey().defaultRandom(),
  organizationId:      text('organization_id').notNull().references(() => organization.id),
  staffId:     uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  caseId:      uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }),
  hoursWorked: numeric('hours_worked', { precision: 5, scale: 2 }).notNull(),
  entryDate:   date('entry_date').notNull(),
  description: text('description'),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),
});

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
