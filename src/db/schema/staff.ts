import { pgTable, uuid, text, integer, date, timestamp, pgEnum, numeric } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const staffRoleEnum = pgEnum('staff_role', [
  'admin',
  'attorney',
  'senior_paralegal',
  'paralegal',
  'junior_paralegal',
]);

export const staffStatusEnum = pgEnum('staff_status', ['active', 'inactive', 'on_leave']);

export const staff = pgTable('staff', {
  id:     uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  userId: text('user_id'),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone').notNull(),
  role: staffRoleEnum('role').notNull(),
  status: staffStatusEnum('status').notNull().default('active'),
  maxCaseload: integer('max_caseload').notNull().default(7),
  startDate: date('start_date').notNull(),
  performanceScore: integer('performance_score').default(0),
  certificationsCount: integer('certifications_count').default(0),
  activeCases: integer('active_cases').default(0),
  totalCases: integer('total_cases').default(0),
  monthlySalary: numeric('monthly_salary', { precision: 10, scale: 2 }).default('0'),
  hourlyRate:    numeric('hourly_rate', { precision: 8, scale: 2 }).default('0'),
  avatarUrl:     text('avatar_url'),
  createdAt:     timestamp('created_at').notNull().defaultNow(),
  updatedAt:     timestamp('updated_at').notNull().defaultNow(),
});

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
