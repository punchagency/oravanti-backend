import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { clients } from './clients';
import { cases } from './cases';
import { documents } from './documents';
import { admins } from './admins';

export const errorSeverityEnum = pgEnum('error_severity', [
  'critical',
  'high',
  'medium',
  'low',
]);

export const errorStatusEnum = pgEnum('error_status', [
  'pending_review',
  'under_review',
  'resolved',
]);

export const aiErrorFlags = pgTable('ai_error_flags', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId:         text('organization_id').notNull().references(() => organization.id),
  clientId:       uuid('client_id').notNull().references(() => clients.id),
  caseId:         uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  documentId:     uuid('document_id').references(() => documents.id),
  title:          text('title').notNull(),
  description:    text('description').notNull(),
  severity:       errorSeverityEnum('severity').notNull(),
  status:         errorStatusEnum('status').notNull().default('pending_review'),
  affectedField:  text('affected_field'),
  documentRef:    text('document_ref'),
  resolvedById:   uuid('resolved_by_id').references(() => admins.id),
  resolvedAt:     timestamp('resolved_at'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type AiErrorFlag = typeof aiErrorFlags.$inferSelect;
export type NewAiErrorFlag = typeof aiErrorFlags.$inferInsert;
