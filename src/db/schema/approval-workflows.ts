import { pgTable, uuid, text, boolean, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const workflowTypeEnum = pgEnum('workflow_type', [
  'case_submission',
  'document_upload',
  'payment_processing',
  'client_addition',
  'staff_certification',
]);

export const approvalWorkflows = pgTable(
  'approval_workflows',
  {
    id:           uuid('id').primaryKey().defaultRandom(),
    firmId:       uuid('firm_id').notNull().references(() => firms.id),
    workflowType: workflowTypeEnum('workflow_type').notNull(),
    chain:        text('chain').notNull(),
    isRequired:   boolean('is_required').notNull().default(false),
    allowBypass:  boolean('allow_bypass').notNull().default(false),
    updatedAt:    timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.workflowType)]
);

export type ApprovalWorkflow = typeof approvalWorkflows.$inferSelect;
export type NewApprovalWorkflow = typeof approvalWorkflows.$inferInsert;
