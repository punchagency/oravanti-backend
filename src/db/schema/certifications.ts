import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const certificationLevelEnum = pgEnum('certification_level', [
  'basic',
  'intermediate',
  'advanced',
  'expert',
]);

export const certifications = pgTable('certifications', {
  code:      text('code').primaryKey(),
  name:      text('name').notNull(),
  level:     certificationLevelEnum('level').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
