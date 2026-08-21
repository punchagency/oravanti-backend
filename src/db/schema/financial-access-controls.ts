import { pgTable, uuid, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const accountTypeEnum = pgEnum('account_type', ['operating', 'trust_iolta']);

// Previously shared with the now-retired `module_permissions`/
// `data_access_controls` tables (dead code — no reader outside their own
// settings module, dropped as part of the dynamic-RBAC migration). This
// table is the one surviving consumer, so the two enums now live here
// under the same Postgres type names as before — nothing to migrate for
// them specifically, only the two dropped tables. Distinct from the
// dynamic role roster in `auth/permissions.ts`: this "role" is a coarse
// financial-visibility tier, not an assignable staff role.
export const permissionRoleEnum = pgEnum('permission_role', [
  'admin',
  'attorney',
  'paralegal',
  'client',
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

export const financialAccessControls = pgTable(
  'financial_access_controls',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    organizationId:      text('organization_id').notNull().references(() => organization.id),
    accountType: accountTypeEnum('account_type').notNull(),
    role:        permissionRoleEnum('role').notNull(),
    permission:  permissionLevelEnum('permission').notNull(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.accountType, t.role)]
);

export type FinancialAccessControl = typeof financialAccessControls.$inferSelect;
export type NewFinancialAccessControl = typeof financialAccessControls.$inferInsert;
