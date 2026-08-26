/**
 * Fields that exist on `immigration_case_details` but must never arrive through
 * a generic patch.
 *
 * The six milestone projections are written only by `recordCaseMilestone`,
 * which also writes the `case_milestones` row, the calendar event and the audit
 * entry. Letting a patch set one directly would leave the three layers
 * disagreeing with no record of who changed what — exactly the drift the single
 * write path exists to prevent.
 *
 * Same reasoning as keeping `assignedToId` out of `updateTaskBody`: a field
 * with a rule attached does not get a generic route.
 */
export const MILESTONE_PROJECTION_FIELDS = [
  "receiptDate",
  "biometricsAppointmentDate",
  "interviewScheduledDate",
  "decisionDate",
  "cardValidTo",
  "greenCardExpirationDate",
] as const;

export type MilestoneProjectionField = (typeof MILESTONE_PROJECTION_FIELDS)[number];
