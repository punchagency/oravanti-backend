import { pgTable, uuid, numeric, date, text, timestamp } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';
import { staff } from './staff';
import { cases } from './cases';

export const timeEntries = pgTable('time_entries', {
  id:          uuid('id').primaryKey().defaultRandom(),
  firmId:      uuid('firm_id').notNull().references(() => firms.id),
  staffId:     uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  caseId:      uuid('case_id').references(() => cases.id),
  hoursWorked: numeric('hours_worked', { precision: 5, scale: 2 }).notNull(),
  entryDate:   date('entry_date').notNull(),
  description: text('description'),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),
});

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
