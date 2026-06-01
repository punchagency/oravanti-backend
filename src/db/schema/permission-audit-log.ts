import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const permissionAuditLog = pgTable('permission_audit_log', {
  id:            uuid('id').primaryKey().defaultRandom(),
  organizationId:        text('organization_id').notNull().references(() => organization.id),
  action:        text('action').notNull(),
  changedBy:     uuid('changed_by').notNull(),
  changedByName: text('changed_by_name').notNull(),
  changedByRole: text('changed_by_role').notNull(),
  createdAt:     timestamp('created_at').notNull().defaultNow(),
});

export type PermissionAuditLog = typeof permissionAuditLog.$inferSelect;
export type NewPermissionAuditLog = typeof permissionAuditLog.$inferInsert;
