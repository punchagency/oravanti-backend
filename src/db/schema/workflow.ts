import { pgTable, uuid, text, integer, boolean, date, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { practiceAreaCaseTypes } from './practice-area-case-types';
import { cases } from './cases';
import { staff } from './staff';

export const workflowStepStatusEnum = pgEnum('workflow_step_status', [
  'pending',
  'in_progress',
  'completed',
  'skipped',
]);

export const workflowTemplates = pgTable('workflow_templates', {
  id:         uuid('id').primaryKey().defaultRandom(),
  caseTypeId: uuid('case_type_id').notNull().unique().references(() => practiceAreaCaseTypes.id),
  name:       text('name').notNull(),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
  updatedAt:  timestamp('updated_at').notNull().defaultNow(),
});

export const workflowTemplateSteps = pgTable('workflow_template_steps', {
  id:          uuid('id').primaryKey().defaultRandom(),
  templateId:  uuid('template_id').notNull().references(() => workflowTemplates.id),
  title:       text('title').notNull(),
  description: text('description'),
  orderIndex:  integer('order_index').notNull(),
  dueInDays:   integer('due_in_days'),
  isRequired:  boolean('is_required').notNull().default(true),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
});

export const caseWorkflowSteps = pgTable('case_workflow_steps', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  caseId:         uuid('case_id').notNull().references(() => cases.id),
  templateStepId: uuid('template_step_id').references(() => workflowTemplateSteps.id),
  title:          text('title').notNull(),
  description:    text('description'),
  orderIndex:     integer('order_index').notNull(),
  dueDate:        date('due_date'),
  status:         workflowStepStatusEnum('status').notNull().default('pending'),
  completedById:  uuid('completed_by_id').references(() => staff.id),
  completedAt:    timestamp('completed_at'),
  notes:          text('notes'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type WorkflowTemplate     = typeof workflowTemplates.$inferSelect;
export type WorkflowTemplateStep = typeof workflowTemplateSteps.$inferSelect;
export type CaseWorkflowStep     = typeof caseWorkflowSteps.$inferSelect;
