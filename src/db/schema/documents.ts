import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { clients } from './clients';
import { cases } from './cases';
import { staff } from './staff';

export const documentCategoryEnum = pgEnum('document_category', [
  'application',
  'supporting',
  'identity',
  'uscis_response',
]);

export const documentStatusEnum = pgEnum('document_status', [
  'approved',
  'review_needed',
  'processing',
]);

export const documents = pgTable('documents', {
  id:           uuid('id').primaryKey().defaultRandom(),
  organizationId:       text('organization_id').notNull().references(() => organization.id),
  clientId:     uuid('client_id').notNull().references(() => clients.id),
  caseId:       uuid('case_id').notNull().references(() => cases.id),
  uploadedById: uuid('uploaded_by_id').notNull().references(() => staff.id),
  name:         text('name').notNull(),
  category:     documentCategoryEnum('category').notNull(),
  fileUrl:      text('file_url').notNull(),
  storagePath:  text('storage_path').notNull(),
  fileSize:     integer('file_size').notNull(),
  mimeType:     text('mime_type').notNull(),
  status:       documentStatusEnum('status').notNull().default('processing'),
  aiChecked:    boolean('ai_checked').notNull().default(false),
  createdAt:    timestamp('created_at').notNull().defaultNow(),
  updatedAt:    timestamp('updated_at').notNull().defaultNow(),
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
