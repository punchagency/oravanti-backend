import {
  boolean,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { staff } from './staff';
import { cases } from './cases';

export const timeEntryStatusEnum = pgEnum('time_entry_status', [
  'pending',
  'approved',
  'rejected',
]);

export const timeEntries = pgTable(
  'time_entries',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    organizationId:      text('organization_id').notNull().references(() => organization.id),
    staffId:     uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
    caseId:      uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }),
    hoursWorked: numeric('hours_worked', { precision: 5, scale: 2 }).notNull(),
    entryDate:   date('entry_date').notNull(),
    description: text('description'),

    // ── Added for the Finance module ────────────────────────────────────────
    /** Non-billable time still counts toward "hours logged", never toward earnings. */
    billable:    boolean('billable').notNull().default(true),
    /**
     * `rejected` exists even though the UI filter is only all|pending|approved,
     * because reject is in the mutation set. Rejected entries are excluded from
     * the pending count and from every earnings sum — an entry that looked
     * approved when it was not would be a billing error.
     */
    status:      timeEntryStatusEnum('status').notNull().default('pending'),
    /**
     * Snapshot of the rate resolved from `billing_rates` by `entryDate` — NOT
     * a copy of `staff.hourlyRate`, which is mutable and would silently
     * restate history the moment a raise is recorded.
     */
    hourlyRate:  numeric('hourly_rate', { precision: 15, scale: 4 }),
    /**
     * hoursWorked * hourlyRate, stored so every earnings roll-up is a single
     * SUM with no join to staff. Re-resolved on approval while still pending;
     * frozen permanently once `invoicedAt` is set, because by then a client
     * has been billed this number.
     */
    amount:      numeric('amount', { precision: 15, scale: 4 }),
    approvedById: uuid('approved_by_id').references(() => staff.id),
    approvedAt:  timestamp('approved_at'),
    rejectionReason: text('rejection_reason'),
    /** Set when the entry lands on an invoice; the line-item FK stays the truth. */
    invoicedAt:  timestamp('invoiced_at'),

    createdAt:   timestamp('created_at').notNull().defaultNow(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('time_entries_org_status_idx').on(table.organizationId, table.status),
    index('time_entries_org_entry_date_idx').on(table.organizationId, table.entryDate),
    index('time_entries_staff_idx').on(table.staffId),
    index('time_entries_case_idx').on(table.caseId),
  ],
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;
export type TimeEntryStatus = (typeof timeEntryStatusEnum.enumValues)[number];
