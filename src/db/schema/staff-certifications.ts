import { pgTable, uuid, text, date, primaryKey } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { certifications } from './certifications';

export const staffCertifications = pgTable(
  'staff_certifications',
  {
    staffId: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
    certificationCode: text('certification_code').notNull().references(() => certifications.code),
    certifiedAt: date('certified_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.certificationCode] })]
);

export type StaffCertification = typeof staffCertifications.$inferSelect;
export type NewStaffCertification = typeof staffCertifications.$inferInsert;
