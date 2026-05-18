import { pgTable, uuid, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { permissionRoleEnum, permissionLevelEnum } from './module-permissions';
import { firms } from './firm-info';

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
    firmId:     uuid('firm_id').notNull().references(() => firms.id),
    dataType:   dataTypeEnum('data_type').notNull(),
    role:       permissionRoleEnum('role').notNull(),
    permission: permissionLevelEnum('permission').notNull(),
    updatedAt:  timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.dataType, t.role)]
);

export type DataAccessControl = typeof dataAccessControls.$inferSelect;
export type NewDataAccessControl = typeof dataAccessControls.$inferInsert;
