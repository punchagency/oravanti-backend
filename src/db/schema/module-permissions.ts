import { pgTable, uuid, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const moduleEnum = pgEnum('module', [
  'dashboard',
  'client_management',
  'cases',
  'documents',
  'ai_error_detection',
  'workflow_approvals',
  'tasks',
  'time_tracking',
  'financial',
  'education',
  'staff_management',
  'uscis_filing',
  'reports_analytics',
]);

export const permissionLevelEnum = pgEnum('permission_level', [
  'full_access',
  'view_only',
  'no_access',
  'assigned',
  'own_only',
  'approve',
  'submit',
  'assign',
  'payments',
]);

export const permissionRoleEnum = pgEnum('permission_role', [
  'admin',
  'attorney',
  'paralegal',
  'client',
]);

export const modulePermissions = pgTable(
  'module_permissions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    organizationId:     text('organization_id').notNull().references(() => organization.id),
    module:     moduleEnum('module').notNull(),
    role:       permissionRoleEnum('role').notNull(),
    permission: permissionLevelEnum('permission').notNull(),
    updatedAt:  timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.module, t.role)]
);

export type ModulePermission = typeof modulePermissions.$inferSelect;
export type NewModulePermission = typeof modulePermissions.$inferInsert;
