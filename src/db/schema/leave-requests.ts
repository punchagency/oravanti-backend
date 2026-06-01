import { pgTable, uuid, text, date, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { organization } from './auth-schema';

export const leaveTypeEnum = pgEnum('leave_type', ['annual', 'sick', 'emergency', 'unpaid']);
export const leaveStatusEnum = pgEnum('leave_status', ['pending', 'approved', 'rejected']);

export const leaveRequests = pgTable('leave_requests', {
  id:      uuid('id').primaryKey().defaultRandom(),
  organizationId:  text('organization_id').notNull().references(() => organization.id),
  staffId: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
  type: leaveTypeEnum('type').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: leaveStatusEnum('status').notNull().default('pending'),
  reason: text('reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type NewLeaveRequest = typeof leaveRequests.$inferInsert;
