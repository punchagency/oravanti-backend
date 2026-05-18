import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { firms } from './firm-info';

export const permissionAuditLog = pgTable('permission_audit_log', {
  id:            uuid('id').primaryKey().defaultRandom(),
  firmId:        uuid('firm_id').notNull().references(() => firms.id),
  action:        text('action').notNull(),
  changedBy:     uuid('changed_by').notNull(),
  changedByName: text('changed_by_name').notNull(),
  changedByRole: text('changed_by_role').notNull(),
  createdAt:     timestamp('created_at').notNull().defaultNow(),
});

export type PermissionAuditLog = typeof permissionAuditLog.$inferSelect;
export type NewPermissionAuditLog = typeof permissionAuditLog.$inferInsert;
