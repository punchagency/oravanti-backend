import { pgTable, uuid, text, integer, date, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { teams } from './teams';
import { staff } from './staff';
import { firms } from './firm-info';

export const caseTypeEnum = pgEnum('case_type', [
  'h1b_visa',
  'green_card',
  'citizenship',
  'l1_visa',
  'asylum',
  'family_petition',
  'e2_treaty_investor',
  'o1_extraordinary_ability',
  'eb1_priority_workers',
  'eb2_advanced_degree',
  'eb3_skilled_workers',
  'eb5_immigrant_investor',
  'work_authorization',
  'travel_document',
  'naturalization',
  'other',
]);

export const caseStatusEnum = pgEnum('case_status', [
  'active',
  'pending_review',
  'on_hold',
  'completed',
  'cancelled',
]);

export const casePriorityEnum = pgEnum('case_priority', ['low', 'medium', 'high', 'critical']);

export const cases = pgTable('cases', {
  id:                      uuid('id').primaryKey().defaultRandom(),
  firmId:                  uuid('firm_id').notNull().references(() => firms.id),
  caseNumber:              text('case_number').notNull().unique(),
  clientId:                uuid('client_id').notNull().references(() => clients.id),
  caseType:                caseTypeEnum('case_type').notNull(),
  status:                  caseStatusEnum('status').notNull().default('active'),
  priority:                casePriorityEnum('priority').notNull().default('medium'),
  assignmentType:          text('assignment_type').notNull().default('internal_team'),
  teamId:                  uuid('team_id').references(() => teams.id),
  assignedStaffId:         uuid('assigned_staff_id').references(() => staff.id),
  requiredCertifications:  text('required_certifications').array().notNull().default([]),
  caseProgress:            integer('case_progress').notNull().default(0),
  filingDate:              date('filing_date').notNull(),
  estimatedCompletionDate: date('estimated_completion_date'),
  nextAppointment:         date('next_appointment'),
  description:             text('description').notNull(),
  notes:                   text('notes'),
  currentEmployer:         text('current_employer'),
  createdAt:               timestamp('created_at').notNull().defaultNow(),
  updatedAt:               timestamp('updated_at').notNull().defaultNow(),
});

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
