import { pgTable, uuid, text, date, primaryKey } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { certifications } from './cases';

export const staffCertifications = pgTable(
  'staff_certifications',
  {
    staffId: uuid('staff_id').notNull().references(() => staff.id, { onDelete: 'cascade' }),
    certificationId: uuid('certification_id').notNull().references(() => certifications.id),
    certifiedAt: date('certified_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.certificationId] })]
);

export type StaffCertification = typeof staffCertifications.$inferSelect;
export type NewStaffCertification = typeof staffCertifications.$inferInsert;
