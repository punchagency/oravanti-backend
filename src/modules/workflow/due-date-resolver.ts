import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { calendarEvents, calendarEventTypeEnum } from "../../db/schema/calendar-events";
import { cases } from "../../db/schema/cases";
import type { DateAnchor } from "../../db/schema/document-requirements";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import { personalInjuryCaseDetails } from "../../db/schema/personal-injury-case-details";
import { workflowModuleActivations } from "../../db/schema/workflow";

/**
 * Resolves a workflow template step's due date from its `dueDateAnchor` +
 * signed `dueDateOffsetDays` — negative offset = before the anchor, positive =
 * after (e.g. N-336 hearing request: `decision_date` +30).
 *
 * NOT the same function `caseTypeDocumentRequirements` materialization uses
 * (`rule-context.ts`'s `anchorDate`/`loadRequirements`), even though both read
 * `date_anchor` off the same enum — that one treats `dueDateOffsetDays` as an
 * unsigned "days before" magnitude, always subtracted. Retrofitting it to
 * signed offsets would risk silently reinterpreting already-stored document-
 * requirement rows, and is out of scope for this change. The two anchor
 * resolvers share the vocabulary (`date_anchor`) and, for the four anchors both
 * systems use (`uscis_interview`/`filing_deadline`/`next_court_date`/
 * `case_opened`), the same underlying lookups — but are deliberately two
 * functions.
 *
 * Returns `null` when the anchor milestone hasn't happened yet (e.g. an
 * `mmi_date`-anchored step before MMI is recorded) — the caller stores a null
 * `dueDate` and re-resolves when the anchor field is written, rather than
 * treating a missing milestone as an error.
 */
export async function resolveDueDate(
  caseId: string,
  anchor: DateAnchor | null,
  offsetDays: number | null,
  /**
   * The step's owning module. Required only by `module_activated`, which is the
   * one anchor that is per case *and* per module rather than a fact about the
   * case alone. Omitting it on such a step yields a null due date rather than a
   * wrong one.
   */
  moduleId?: string,
): Promise<string | null> {
  if (!anchor || offsetDays === null) return null;

  const anchorDate = await getAnchorDate(caseId, anchor, moduleId);
  if (!anchorDate) return null;

  return applyOffset(anchorDate, offsetDays);
}

/**
 * The signed-offset arithmetic, with no database in it — negative offsets move
 * before the anchor, positive after, zero lands on it.
 *
 * Separated from `resolveDueDate` so the date maths can be tested directly;
 * every template step's due date is this one line, so it is worth pinning down.
 */
export function applyOffset(anchorDate: Date, offsetDays: number): string {
  const resolved = new Date(anchorDate);
  resolved.setUTCDate(resolved.getUTCDate() + offsetDays);
  return resolved.toISOString().split("T")[0];
}

/**
 * Anchors the resolver knowingly cannot resolve, because no column backs them.
 *
 * A step anchored on one of these always gets a null due date and renders as
 * "due once recorded". That is a deliberate, visible state — but for sixteen
 * AOS steps it was an accidental one for a long time, because nothing checked.
 * `anchor-coverage.test.ts` now asserts no in-scope template step uses a value
 * from this set, so adding an anchor without a backing field fails the suite
 * rather than silently producing undated work.
 *
 * Shrink this list by adding a column; never grow it to make a test pass.
 */
export const UNBACKED_ANCHORS = new Set<DateAnchor>([
  // N-400 oath ceremony. Out of scope for the AOS phase, and the N-400
  // template DOES anchor a step on it - see KNOWN_UNDATED in
  // anchor-coverage.test.ts, which pins that gap so it cannot grow.
  "oath_ceremony_date",
]);

async function getAnchorDate(
  caseId: string,
  anchor: DateAnchor,
  moduleId?: string,
): Promise<Date | null> {
  switch (anchor) {
    case "case_opened": {
      const [row] = await db.select({ createdAt: cases.createdAt }).from(cases).where(eq(cases.id, caseId)).limit(1);
      return row?.createdAt ?? null;
    }
    case "module_activated": {
      // Null without a module, and null before the module has activated. Both
      // are the honest answer: a step whose module has not opened has no
      // deadline yet, and renders as "due once recorded" until it does.
      if (!moduleId) return null;
      const [row] = await db
        .select({ activatedAt: workflowModuleActivations.activatedAt })
        .from(workflowModuleActivations)
        .where(
          and(
            eq(workflowModuleActivations.caseId, caseId),
            eq(workflowModuleActivations.moduleId, moduleId),
          ),
        )
        .limit(1);
      return row?.activatedAt ?? null;
    }
    case "next_court_date": {
      const [row] = await db.select({ nextCourtDate: cases.nextCourtDate }).from(cases).where(eq(cases.id, caseId)).limit(1);
      return row?.nextCourtDate ?? null;
    }
    case "uscis_interview":
      return nextScheduledCalendarEvent(caseId, "uscis_interview");
    case "filing_deadline":
      return nextScheduledCalendarEvent(caseId, "filing_deadline");

    // ── Immigration ──────────────────────────────────────────────────────
    case "receipt_date":
    case "biometrics_appointment":
    case "card_valid_to":
    case "interview_scheduled_date":
    case "decision_date":
    case "green_card_expiration_date":
    case "eligibility_date":
    case "oath_ceremony_date":
    case "demand_letter_sent_date":
    case "service_completed_date":
    case "ruling_date":
    case "filed_date":
      return immigrationAnchorDate(caseId, anchor);

    // ── Personal injury ──────────────────────────────────────────────────
    case "incident_date":
    case "statute_of_limitations_date":
    case "mmi_date":
    case "demand_sent_date":
    case "defendant_answer_date":
    case "msj_filed_date":
    case "mediation_scheduled_date":
    case "trial_date":
    case "verdict_date":
    case "funds_received_date":
      return personalInjuryAnchorDate(caseId, anchor);
  }
}

async function nextScheduledCalendarEvent(
  caseId: string,
  eventType: (typeof calendarEventTypeEnum.enumValues)[number],
): Promise<Date | null> {
  const rows = await db
    .select({ startTime: calendarEvents.startTime, customDeadlineDate: calendarEvents.customDeadlineDate })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.caseId, caseId), eq(calendarEvents.eventType, eventType)));

  const now = Date.now();
  const dates = rows
    .map((r) => (r.customDeadlineDate ? new Date(r.customDeadlineDate) : r.startTime))
    .filter((d): d is Date => !!d && d.getTime() >= now);
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates[0] ?? null;
}

// `filed_date` doesn't have its own column — the AOS/N-400 matter's filing
// moment is `cases.filingDate`, which the immigration-specific anchors below
// don't otherwise need to duplicate onto `immigration_case_details`.
async function immigrationAnchorDate(
  caseId: string,
  anchor: Extract<
    DateAnchor,
    | "receipt_date"
    | "biometrics_appointment"
    | "card_valid_to"
    | "interview_scheduled_date"
    | "decision_date"
    | "green_card_expiration_date"
    | "eligibility_date"
    | "oath_ceremony_date"
    | "demand_letter_sent_date"
    | "service_completed_date"
    | "ruling_date"
    | "filed_date"
  >,
): Promise<Date | null> {
  if (anchor === "filed_date") {
    const [row] = await db.select({ filingDate: cases.filingDate }).from(cases).where(eq(cases.id, caseId)).limit(1);
    return row?.filingDate ? new Date(row.filingDate) : null;
  }

  const [row] = await db
    .select({
      eligibilityDate: immigrationCaseDetails.eligibilityDate,
      demandLetterSentDate: immigrationCaseDetails.demandLetterSentDate,
      serviceCompletedDate: immigrationCaseDetails.serviceCompletedDate,
      rulingDate: immigrationCaseDetails.rulingDate,
      receiptDate: immigrationCaseDetails.receiptDate,
      biometricsAppointmentDate: immigrationCaseDetails.biometricsAppointmentDate,
      interviewScheduledDate: immigrationCaseDetails.interviewScheduledDate,
      decisionDate: immigrationCaseDetails.decisionDate,
      cardValidTo: immigrationCaseDetails.cardValidTo,
      greenCardExpirationDate: immigrationCaseDetails.greenCardExpirationDate,
    })
    .from(immigrationCaseDetails)
    .where(eq(immigrationCaseDetails.caseId, caseId))
    .limit(1);
  if (!row) return null;

  // Same shape as `personalInjuryAnchorDate` below: one exhaustive map, so a
  // new anchor added to the enum fails to compile until it is given a source
  // rather than silently resolving to null.
  const map: Record<typeof anchor, string | null> = {
    eligibility_date: row.eligibilityDate,
    demand_letter_sent_date: row.demandLetterSentDate,
    service_completed_date: row.serviceCompletedDate,
    ruling_date: row.rulingDate,
    receipt_date: row.receiptDate,
    biometrics_appointment: row.biometricsAppointmentDate,
    interview_scheduled_date: row.interviewScheduledDate,
    decision_date: row.decisionDate,
    card_valid_to: row.cardValidTo,
    green_card_expiration_date: row.greenCardExpirationDate,
    // N-400 only, and out of scope for the AOS phase - the one immigration
    // anchor still without a backing column. A step anchored on it resolves to
    // null and shows "due once recorded".
    //
    // `filed_date` is absent because the early return above already narrowed it
    // out of `anchor` - TypeScript will not let it be listed here.
    oath_ceremony_date: null,
  };
  const value = map[anchor];
  return value ? new Date(value) : null;
}

async function personalInjuryAnchorDate(
  caseId: string,
  anchor: Extract<
    DateAnchor,
    | "incident_date"
    | "statute_of_limitations_date"
    | "mmi_date"
    | "demand_sent_date"
    | "defendant_answer_date"
    | "msj_filed_date"
    | "mediation_scheduled_date"
    | "trial_date"
    | "verdict_date"
    | "funds_received_date"
  >,
): Promise<Date | null> {
  const [row] = await db
    .select({
      incidentDate: personalInjuryCaseDetails.incidentDate,
      statuteOfLimitationsDate: personalInjuryCaseDetails.statuteOfLimitationsDate,
      mmiDate: personalInjuryCaseDetails.mmiDate,
      demandSentDate: personalInjuryCaseDetails.demandSentDate,
      defendantAnswerDate: personalInjuryCaseDetails.defendantAnswerDate,
      msjFiledDate: personalInjuryCaseDetails.msjFiledDate,
      mediationScheduledDate: personalInjuryCaseDetails.mediationScheduledDate,
      trialDate: personalInjuryCaseDetails.trialDate,
      verdictDate: personalInjuryCaseDetails.verdictDate,
      fundsReceivedDate: personalInjuryCaseDetails.fundsReceivedDate,
    })
    .from(personalInjuryCaseDetails)
    .where(eq(personalInjuryCaseDetails.caseId, caseId))
    .limit(1);
  if (!row) return null;

  const map: Record<typeof anchor, string | null> = {
    incident_date: row.incidentDate,
    statute_of_limitations_date: row.statuteOfLimitationsDate,
    mmi_date: row.mmiDate,
    demand_sent_date: row.demandSentDate,
    defendant_answer_date: row.defendantAnswerDate,
    msj_filed_date: row.msjFiledDate,
    mediation_scheduled_date: row.mediationScheduledDate,
    trial_date: row.trialDate,
    verdict_date: row.verdictDate,
    funds_received_date: row.fundsReceivedDate,
  };
  const value = map[anchor];
  return value ? new Date(value) : null;
}
