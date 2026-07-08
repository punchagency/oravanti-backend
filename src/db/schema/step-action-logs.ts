import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { cases } from './cases';
import { staff } from './staff';
import { caseWorkflowSteps, workflowModules } from './workflow';

export const stepActionLogs = pgTable('step_action_logs', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  caseId:         uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  stepId:         uuid('step_id').notNull().references(() => caseWorkflowSteps.id, { onDelete: 'cascade' }),
  moduleId:       uuid('module_id').references(() => workflowModules.id),
  action:         text('action').notNull(),
  title:          text('title').notNull(),
  actorId:        uuid('actor_id').references(() => staff.id),
  actorName:      text('actor_name'),
  assigneeId:     uuid('assignee_id').references(() => staff.id),
  assigneeName:   text('assignee_name'),
  note:           text('note'),
  timeTakenMs:    integer('time_taken_ms'),
  metadata:       jsonb('metadata'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
});

export type StepActionLog = typeof stepActionLogs.$inferSelect;
