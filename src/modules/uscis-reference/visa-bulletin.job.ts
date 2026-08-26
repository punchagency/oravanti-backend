import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import { createModuleLogger } from "../../lib/logging/log";
import { recordAuditEvent } from "../shared/audit.service";
import { materializeTasksForCase } from "../workflow/task-materialization.service";
import {
  cutoffsForMonth,
  isPriorityDateCurrent,
  latestBulletinMonth,
  type CutoffRow,
} from "./visa-bulletin.service";

const log = createModuleLogger("uscis-reference.visa-bulletin-job");

/**
 * The monthly re-evaluation: does each open matter's priority date sit before
 * the cut-off in the newest bulletin on record?
 *
 * ─── Failure posture ────────────────────────────────────────────────────────
 *
 * Two rules, both about not making things worse:
 *
 *   1. **Never flip a flag off because something failed to load.** If there is
 *      no bulletin on record, this returns without touching a single case. A
 *      matter that was current yesterday stays current; the alternative is a
 *      failed fetch silently closing the I-485 package on every sequential case
 *      in the firm.
 *   2. **Never overrule a person.** `priorityDateIsManual` matters are filtered
 *      out in SQL, not skipped in a loop, so the override is enforced by the
 *      query rather than by remembering to check.
 *
 * Retrogression means this genuinely does flip flags *off* sometimes — a cut-off
 * can move backwards and un-current a case. That is correct and is why each
 * change is audited with the reason the bulletin gave.
 */

/**
 * Matters that are over. Their flag has no consequence, and re-materializing one
 * would add tasks to a case nobody is working.
 */
const FINISHED_STATUSES = ["closed", "dismissed"] as const;

export interface BulletinSweepResult {
  bulletinMonth: string | null;
  evaluated: number;
  changed: number;
}

export async function visaBulletinSweep(): Promise<BulletinSweepResult> {
  const bulletinMonth = await latestBulletinMonth();
  if (!bulletinMonth) {
    // Rule 1. Nothing on record is not the same as "nobody is current".
    log.warn("uscis.visa_bulletin_absent", {});
    return { bulletinMonth: null, evaluated: 0, changed: 0 };
  }

  const rows: CutoffRow[] = await cutoffsForMonth(bulletinMonth);
  if (rows.length === 0) {
    log.warn("uscis.visa_bulletin_empty", { bulletinMonth });
    return { bulletinMonth, evaluated: 0, changed: 0 };
  }

  const matters = await db
    .select({
      caseId: immigrationCaseDetails.caseId,
      organizationId: immigrationCaseDetails.organizationId,
      caseNumber: cases.caseNumber,
      priorityDate: immigrationCaseDetails.priorityDate,
      preferenceCategory: immigrationCaseDetails.preferenceCategory,
      chargeabilityArea: immigrationCaseDetails.countryOfChargeability,
      isCurrent: immigrationCaseDetails.priorityDateIsCurrent,
    })
    .from(immigrationCaseDetails)
    .innerJoin(cases, eq(cases.id, immigrationCaseDetails.caseId))
    .where(
      and(
        // Rule 2, enforced by the query.
        eq(immigrationCaseDetails.priorityDateIsManual, false),
        isNotNull(immigrationCaseDetails.preferenceCategory),
        notInArray(cases.status, [...FINISHED_STATUSES]),
      ),
    );

  let changed = 0;

  for (const matter of matters) {
    const verdict = isPriorityDateCurrent({
      priorityDate: matter.priorityDate,
      category: matter.preferenceCategory,
      chargeabilityArea: matter.chargeabilityArea,
      rows,
    });

    if (verdict.current === matter.isCurrent) continue;

    await db
      .update(immigrationCaseDetails)
      .set({ priorityDateIsCurrent: verdict.current, updatedAt: new Date() })
      .where(eq(immigrationCaseDetails.caseId, matter.caseId));

    await recordAuditEvent({
      action: "case.updated",
      entityType: "case",
      entityId: matter.caseId,
      parentEntityType: "case",
      parentEntityId: matter.caseId,
      organizationId: matter.organizationId,
      // No actor: this is the system acting on a published bulletin, and
      // attributing it to a person would be a lie in the one place that must
      // not contain any.
      summary:
        `Priority date on ${matter.caseNumber} ` +
        `${verdict.current ? "became current" : "is no longer current"} ` +
        `under the ${bulletinMonth} Visa Bulletin. ${verdict.because}`,
      metadata: {
        table: "immigration_case_details",
        fields: ["priorityDateIsCurrent"],
        priorityDateIsCurrent: verdict.current,
        bulletinMonth,
        reason: verdict.because,
      },
    });

    // The flag is a condition field, so this is what actually opens (or, on
    // retrogression, stops adding to) the I-485 package.
    await materializeTasksForCase(matter.caseId);
    changed++;
  }

  log.action("uscis.visa_bulletin_sweep_completed", {
    bulletinMonth,
    evaluated: matters.length,
    changed,
  });

  return { bulletinMonth, evaluated: matters.length, changed };
}
