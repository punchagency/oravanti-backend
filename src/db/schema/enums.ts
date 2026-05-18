import { pgEnum } from 'drizzle-orm/pg-core';

export const filingTypeEnum = pgEnum('filing_type', [
  'I-130',
  'I-485',
  'I-765',
  'I-140',
  'N-400',
  'I-131',
]);

export const assignmentTypeEnum = pgEnum('assignment_type', ['internal_team', 'external_contractor']);
export const urgencyLevelEnum = pgEnum('urgency_level', ['normal', 'urgent', 'critical']);
export const assignmentStatusEnum = pgEnum('assignment_status', ['pending', 'active', 'completed', 'cancelled']);
