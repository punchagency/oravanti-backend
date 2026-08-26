import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { calendarEvents } from "../../db/schema/calendar-events";
import { cases } from "../../db/schema/cases";
import {
  caseMilestones,
  type CaseMilestone,
  type CaseMilestoneRow,
} from "../../db/schema/case-milestones";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import { NotFoundError } from "../../utils/error/app-error";
import { createModuleLogger } from "../../lib/logging/log";
import { recordAuditEvent } from "../shared/audit.service";
import { reresolveDueDates } from "./task-materialization.service";

const log = createModuleLogger("workflow.case-milestone");

/**
 * The one way to record what the agency did.
 *
 * A milestone date lands in three places, because three different things need
 * it and none is served well by the others:
 *
 *   1. `case_milestones`  — the source of truth and the chronology. Carries the
 *                           notice it was read off, who entered it, and a note.
 *                           Practice-area agnostic.
 *   2. `immigration_case_details.<date>` — a denormalized projection, so
 *                           `resolveDueDate` stays a single-row lookup.
 *   3. `calendar_events`  — for the two that are genuine appointments, so staff
 *                           see them on a calendar.
 *
 * That redundancy is only safe because exactly one function writes all three,
 * which is this one. The projection columns are deliberately excluded from
 * `ImmigrationDetailsPatch`, so nothing can set a date without also writing the
 * milestone row, the calendar entry and the audit trail. Needing to set one of
 * those columns directly is a signal that this function wants another
 * parameter, not that the column wants a second writer.
 *
 * Recording a milestone is what finally gives the second half of an AOS matter
 * its deadlines: sixteen of the template's thirty-six steps anchor on one of
 * these six dates, and every one of them resolved to null before this existed.
 */

/** The projection column each milestone writes. One entry per enum value. */
const PROJECTION_COLUMN = {
  receipt: "receiptDate",
  biometrics_appointment: "biometricsAppointmentDate",
  interview_scheduled: "interviewScheduledDate",
  decision: "decisionDate",
  card_valid_to: "cardValidTo",
  green_card_expiration: "greenCardExpirationDate",
} as const satisfies Record<CaseMilestone, string>;

/**
 * The two milestones that are appointments someone attends, and the existing
 * `calendar_event_type` each maps to. The rest are dates printed on a notice,
 * not events in a diary, and putting them on a calendar would be noise.
 */
const CALENDAR_EVENT = {
  biometrics_appointment: { type: "biometric", title: "Biometrics appointment (ASC)" },
  interview_scheduled: { type: "uscis_interview", title: "USCIS interview" },
} as const;

/** Used in audit summaries, which are read years later and cannot be regenerated. */
const MILESTONE_LABEL: Record<CaseMilestone, string> = {
  receipt: "Receipt notice",
  biometrics_appointment: "Biometrics appointment",
  interview_scheduled: "Interview",
  decision: "Decision",
  card_valid_to: "EAD/AP card expiry",
  green_card_expiration: "Green card expiry",
};

export interface RecordCaseMilestoneParams {
  caseId: string;
  organizationId: string;
  milestone: CaseMilestone;
  /** `YYYY-MM-DD`. */
  occurredOn: string;
  /** The I-797C or other notice this date was read off. */
  noticeNumber?: string | null;
  note?: string | null;
  actorStaffId: string | null;
}

export async function recordCaseMilestone(
  params: RecordCaseMilestoneParams,
): Promise<CaseMilestoneRow> {
  const { caseId, organizationId, milestone, occurredOn } = params;

  const [caseRow] = await db
    .select({ id: cases.id, caseNumber: cases.caseNumber })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!caseRow) throw new NotFoundError("Case not found");

  const [existing] = await db
    .select({ id: caseMilestones.id, occurredOn: caseMilestones.occurredOn })
    .from(caseMilestones)
    .where(and(eq(caseMilestones.caseId, caseId), eq(caseMilestones.milestone, milestone)))
    .limit(1);

  // All three writes in one transaction: a projection that disagrees with its
  // milestone row is the failure mode this design exists to prevent.
  const saved = await db.transaction(async (tx) => {
    const values = {
      organizationId,
      caseId,
      milestone,
      occurredOn,
      noticeNumber: params.noticeNumber ?? null,
      note: params.note ?? null,
      recordedByStaffId: params.actorStaffId,
    };

    const [row] = existing
      ? await tx
          .update(caseMilestones)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(caseMilestones.id, existing.id))
          .returning()
      : await tx.insert(caseMilestones).values(values).returning();

    await tx
      .update(immigrationCaseDetails)
      .set({ [PROJECTION_COLUMN[milestone]]: occurredOn, updatedAt: new Date() })
      .where(eq(immigrationCaseDetails.caseId, caseId));

    await upsertCalendarEvent(tx, { caseId, organizationId, milestone, occurredOn });

    return row;
  });

  const corrected = existing !== undefined && existing.occurredOn !== occurredOn;
  await recordAuditEvent({
    action: corrected ? "case.milestone_corrected" : "case.milestone_recorded",
    entityType: "case",
    entityId: caseId,
    organizationId,
    summary: corrected
      ? `${MILESTONE_LABEL[milestone]} on ${caseRow.caseNumber} corrected from ${existing.occurredOn} to ${occurredOn}`
      : `${MILESTONE_LABEL[milestone]} on ${caseRow.caseNumber} recorded as ${occurredOn}`,
    metadata: {
      milestone,
      occurredOn,
      ...(corrected ? { previousOccurredOn: existing.occurredOn } : {}),
      ...(params.noticeNumber ? { noticeNumber: params.noticeNumber } : {}),
    },
    actor: params.actorStaffId ? { staffId: params.actorStaffId } : undefined,
  });

  // The point of the whole exercise: this is what moves the steps anchored on
  // this date off "due once recorded".
  const dueDatesUpdated = await reresolveDueDates(caseId);
  log.action("workflow.milestone_recorded", {
    caseId,
    milestone,
    occurredOn,
    dueDatesUpdated,
  });

  return saved;
}

/**
 * Keeps one calendar event per appointment milestone, matched on case + type.
 *
 * Rescheduling is the normal case — USCIS moves appointments — so this updates
 * the event in place rather than leaving a trail of stale ones on the calendar.
 */
async function upsertCalendarEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: {
    caseId: string;
    organizationId: string;
    milestone: CaseMilestone;
    occurredOn: string;
  },
): Promise<void> {
  const spec = CALENDAR_EVENT[params.milestone as keyof typeof CALENDAR_EVENT];
  if (!spec) return;

  const startTime = new Date(`${params.occurredOn}T00:00:00.000Z`);

  const [existing] = await tx
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.caseId, params.caseId), eq(calendarEvents.eventType, spec.type)))
    .limit(1);

  if (existing) {
    await tx
      .update(calendarEvents)
      .set({ startTime, status: "scheduled" })
      .where(eq(calendarEvents.id, existing.id));
    return;
  }

  await tx.insert(calendarEvents).values({
    organizationId: params.organizationId,
    caseId: params.caseId,
    eventType: spec.type,
    title: spec.title,
    startTime,
  });
}

/** The case chronology, oldest first — what a mandamus factual background is built from. */
export async function listCaseMilestones(
  caseId: string,
  organizationId: string,
): Promise<CaseMilestoneRow[]> {
  return db
    .select()
    .from(caseMilestones)
    .where(
      and(eq(caseMilestones.caseId, caseId), eq(caseMilestones.organizationId, organizationId)),
    )
    .orderBy(caseMilestones.occurredOn);
}
