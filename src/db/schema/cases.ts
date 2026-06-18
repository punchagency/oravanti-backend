import { pgTable, uuid, text, integer, date, timestamp, pgEnum, varchar } from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { teams } from './teams';
import { staff } from './staff';
import { admins } from './admins';
import { organization } from './auth-schema';
import { practiceAreaCaseTypes } from './practice-area-case-types';
import { practiceAreas } from './practice-areas';

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
  organizationId:                  text('organization_id').notNull().references(() => organization.id),
  caseNumber:              text('case_number').notNull().unique(),
  clientId:                uuid('client_id').notNull().references(() => clients.id),
  practiceAreaId:          uuid('practice_area_id').notNull().references(() => practiceAreas.id),
  caseTypeId:              uuid('case_type_id').notNull().references(() => practiceAreaCaseTypes.id),
  caseType:                varchar('case_type', { length: 100 }).notNull(),
  status:                  caseStatusEnum('status').notNull().default('active'),
  priority:                casePriorityEnum('priority').notNull().default('medium'),
  assignmentType:          text('assignment_type').notNull().default('internal_team'),
  teamId:                  uuid('team_id').references(() => teams.id),
  assignedStaffId:         uuid('assigned_staff_id').references(() => staff.id),
  requiredCertifications:  text('required_certifications').array().notNull().default([]),
  caseProgress:            integer('case_progress').notNull().default(0),
  leadId:                  uuid('lead_id'),
  filingDate:              date('filing_date').notNull(),
  estimatedCompletionDate: date('estimated_completion_date'),
  nextAppointment:         date('next_appointment'),
  description:             text('description').notNull(),
  notes:                   text('notes'),
  createdByAdminId:        uuid('created_by_admin_id').references(() => admins.id),
  createdByStaffId:        uuid('created_by_staff_id').references(() => staff.id),
  createdAt:               timestamp('created_at').notNull().defaultNow(),
  updatedAt:               timestamp('updated_at').notNull().defaultNow(),
});

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;
