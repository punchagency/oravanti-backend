import { pgTable, uuid, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { permissionRoleEnum, permissionLevelEnum } from './module-permissions';
import { organization } from './auth-schema';

export const dataTypeEnum = pgEnum('data_type', [
  'client_pii',
  'case_documents',
  'financial_records',
  'staff_information',
  'ai_error_flags',
  'time_tracking_data',
]);

export const dataAccessControls = pgTable(
  'data_access_controls',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    organizationId:     text('organization_id').notNull().references(() => organization.id),
    dataType:   dataTypeEnum('data_type').notNull(),
    role:       permissionRoleEnum('role').notNull(),
    permission: permissionLevelEnum('permission').notNull(),
    updatedAt:  timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.dataType, t.role)]
);

export type DataAccessControl = typeof dataAccessControls.$inferSelect;
export type NewDataAccessControl = typeof dataAccessControls.$inferInsert;
