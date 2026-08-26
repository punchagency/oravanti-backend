import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import {
  evaluateI864Income,
  povertyGuidelinesFor,
} from "../uscis-reference/filing-fee.service";
import { checkPackageEditions, AOS_PACKAGE_FORMS } from "../uscis-reference/form-edition.service";

/**
 * The § 1.5 pitfalls, as rules.
 *
 * ─── Posture ────────────────────────────────────────────────────────────────
 *
 * Exactly one of these blocks: the form-edition check. A superseded edition is a
 * certain rejection with no judgement in it — USCIS bounces the package and
 * there is nothing to weigh. Everything else is a WARNING, because every other
 * pitfall here is fact-specific and the right answer depends on things the
 * system cannot see.
 *
 * That is a deliberate reading of the source document's own closing instruction,
 * and it is worth stating plainly because the temptation runs the other way: a
 * hard block feels safer to build. It is not. Blocking travel because the system
 * has not been told the beneficiary holds valid H-1B status stops lawful travel
 * on the strength of a missing field. A warning an attorney reads and dismisses
 * costs a click; a block costs a client their trip.
 *
 * ─── Silence on missing input ───────────────────────────────────────────────
 *
 * Every rule returns nothing when it lacks what it needs. A rule that fired on
 * absence would put a permanent warning on every case until someone filled in a
 * field they may have no reason to fill in, and a screen of permanent warnings
 * is a screen nobody reads.
 *
 * ─── Purity ─────────────────────────────────────────────────────────────────
 *
 * `evaluateAosPitfalls` takes a plain object and touches nothing. `checkCase`
 * below does the I/O and hands it the result. That split is what lets the rules
 * be tested exhaustively, which is the only way anyone can be confident in a
 * list of legal edge cases.
 */

export type PitfallSeverity = "block" | "warning";

export interface Pitfall {
  /** Stable identifier, safe to key UI on. Never re-cased or re-worded. */
  code:
    | "travel_without_advance_parole"
    | "employment_before_work_authorization"
    | "i864_income_below_threshold"
    | "i693_bound_to_closed_application"
    | "status_expired_before_filing"
    | "form_edition_superseded";
  severity: PitfallSeverity;
  /** One sentence, written for an attorney, naming the specific facts. */
  message: string;
}

/** Everything the rules read. Assembled by `checkCase`; no rule fetches. */
export interface AosPitfallInput {
  today: string;
  filingDate: string | null;
  caseIsOpen: boolean;
  filingTrack: "concurrent" | "sequential" | null;

  travelWhilePending: { departureDate: string; returnDate: string | null; hadAdvanceParole: boolean }[];
  beneficiaryStatusExpirationDate: string | null;

  employmentStartDate: string | null;
  hasWorkAuthorization: boolean;
  cardValidTo: string | null;

  sponsorIncomeCents: number | null;
  sponsorHouseholdSize: number | null;
  i864Verdict: ReturnType<typeof evaluateI864Income> | null;

  i693SignedDate: string | null;

  supersededForms: string[];
}

export function evaluateAosPitfalls(input: AosPitfallInput): Pitfall[] {
  return [
    travelWithoutAdvanceParole(input),
    employmentBeforeWorkAuthorization(input),
    i864IncomeBelowThreshold(input),
    i693BoundToClosedApplication(input),
    statusExpiredBeforeFiling(input),
    formEditionSuperseded(input),
  ].filter((p): p is Pitfall => p !== null);
}

/**
 * § 1.5 #1 — departing the U.S. while an I-485 is pending, without advance
 * parole, is treated as abandoning the application.
 *
 * A warning, not a block. A beneficiary in valid H-1B or L status may travel on
 * that status without abandoning anything, and the system is not told which
 * status they hold — so blocking here would stop lawful travel on the strength
 * of a field nobody filled in.
 */
function travelWithoutAdvanceParole(input: AosPitfallInput): Pitfall | null {
  if (!input.filingDate) return null; // Nothing is pending yet.

  const risky = input.travelWhilePending.filter(
    (t) => !t.hadAdvanceParole && t.departureDate >= input.filingDate!,
  );
  if (risky.length === 0) return null;

  const dates = risky.map((t) => t.departureDate).join(", ");
  return {
    code: "travel_without_advance_parole",
    severity: "warning",
    message:
      `Travel on ${dates} is recorded with no advance parole while the I-485 was pending. ` +
      `Departing without advance parole abandons the application unless the beneficiary ` +
      `travelled in valid H or L status — confirm which applies.`,
  };
}

/**
 * § 1.5 #2 — working before the EAD is in hand.
 *
 * Compares against the EAD's own validity, not the filing date: the I-765 being
 * filed authorises nothing.
 */
function employmentBeforeWorkAuthorization(input: AosPitfallInput): Pitfall | null {
  if (!input.employmentStartDate) return null;
  if (input.hasWorkAuthorization) return null; // Independently authorised — H-1B, L-2, existing EAD.

  // An EAD in hand covering the start date settles it.
  if (input.cardValidTo && input.employmentStartDate <= input.cardValidTo) return null;

  return {
    code: "employment_before_work_authorization",
    severity: "warning",
    message:
      `Employment is recorded as starting ${input.employmentStartDate} with no work ` +
      `authorisation on file. Filing the I-765 does not itself authorise work — confirm ` +
      `the EAD was in hand, or that the beneficiary is independently work-authorised.`,
  };
}

/** § 1.5 #3 — the I-864 sponsor's income against the poverty guidelines. */
function i864IncomeBelowThreshold(input: AosPitfallInput): Pitfall | null {
  const verdict = input.i864Verdict;
  if (!verdict) return null;

  // "unknown" is not a warning about the case — it is a gap in our reference
  // data (an unseeded AK/HI table), and warning about it on the case would put
  // our problem in front of the client's attorney as if it were theirs.
  if (verdict.verdict !== "below") return null;

  return {
    code: "i864_income_below_threshold",
    severity: "warning",
    message:
      `${verdict.because} Consider a joint sponsor, or counting household member income on an I-864A.`,
  };
}

/**
 * § 1.5 #4 — an I-693 tied to an application that is no longer pending.
 *
 * Deliberately NOT a date rule. Since 11 June 2025 the I-693 has no fixed
 * validity window: it is good for as long as the application it was filed with
 * is pending. The pitfall is therefore not an old signature — it is a signature
 * attached to a dead application, which needs a fresh exam on any refiling.
 */
function i693BoundToClosedApplication(input: AosPitfallInput): Pitfall | null {
  if (!input.i693SignedDate) return null;
  if (input.caseIsOpen) return null;

  return {
    code: "i693_bound_to_closed_application",
    severity: "warning",
    message:
      `The I-693 signed ${input.i693SignedDate} was filed with an application that is no ` +
      `longer pending. It has no validity of its own — a refiling needs a new medical exam.`,
  };
}

/**
 * § 1.5 #5 — status running out before a sequential matter can file.
 *
 * Only meaningful on the sequential track: a concurrent filing goes in
 * immediately, so there is no waiting period to fall out of status during.
 * Falling out of status while waiting for a priority date does not by itself
 * sink the case — § 245(k) and the immediate-relative exemptions exist — which
 * is exactly why an attorney, not a rule, decides what it means.
 */
function statusExpiredBeforeFiling(input: AosPitfallInput): Pitfall | null {
  if (input.filingTrack !== "sequential") return null;
  if (input.filingDate) return null; // Already filed; the question is moot.

  const expiry = input.beneficiaryStatusExpirationDate;
  if (!expiry) return null;
  if (expiry > input.today) return null;

  return {
    code: "status_expired_before_filing",
    severity: "warning",
    message:
      `The beneficiary's status expired ${expiry} and the I-485 has not been filed. ` +
      `Review whether an exemption applies before filing.`,
  };
}

/**
 * § 1.5 #6 — the only hard block.
 *
 * USCIS rejects a package built on a superseded edition, sometimes with no grace
 * period at all. There is no judgement to exercise and no fact that changes the
 * answer, which is what makes it the one rule safe to block on.
 */
function formEditionSuperseded(input: AosPitfallInput): Pitfall | null {
  if (input.supersededForms.length === 0) return null;

  return {
    code: "form_edition_superseded",
    severity: "block",
    message:
      `${input.supersededForms.join(", ")} will not be the edition USCIS accepts on the ` +
      `expected filing date. Rebuild the package on the current edition before filing.`,
  };
}

// ── I/O ────────────────────────────────────────────────────────────────────

/** Statuses that mean the matter is no longer pending before USCIS. */
const CLOSED_STATUSES = new Set(["closed", "dismissed"]);

/**
 * Loads what the rules need and runs them.
 *
 * The only function here that touches the database, so the rules above stay
 * testable without one.
 */
export async function checkCase(caseId: string, today: string): Promise<Pitfall[]> {
  const [row] = await db
    .select({
      details: immigrationCaseDetails,
      status: cases.status,
      filingDate: cases.filingDate,
    })
    .from(immigrationCaseDetails)
    .innerJoin(cases, eq(cases.id, immigrationCaseDetails.caseId))
    .where(eq(immigrationCaseDetails.caseId, caseId))
    .limit(1);

  if (!row) return [];
  const d = row.details;

  const i864Verdict =
    d.sponsorIncomeCents !== null && d.sponsorHouseholdSize !== null
      ? evaluateI864Income({
          // The 48-state table is keyed "48"; AK and HI have their own and are
          // deliberately unseeded, so those come back with no rows and the
          // verdict is "unknown" rather than a stale threshold.
          rows: await povertyGuidelinesFor(
            d.sponsorState === "AK" || d.sponsorState === "HI" ? d.sponsorState : "48",
            Number(today.slice(0, 4)),
          ),
          householdSize: d.sponsorHouseholdSize,
          sponsorIncomeCents: d.sponsorIncomeCents,
          isActiveDutyMilitary: d.sponsorIsActiveDutyMilitary,
        })
      : null;

  const editions = await checkPackageEditions({
    formCodes: [...AOS_PACKAGE_FORMS],
    filingDate: row.filingDate ?? today,
    today,
  });

  return evaluateAosPitfalls({
    today,
    filingDate: row.filingDate ?? null,
    caseIsOpen: !CLOSED_STATUSES.has(row.status),
    filingTrack: d.filingTrack,
    travelWhilePending: d.travelWhilePending,
    beneficiaryStatusExpirationDate: d.beneficiaryStatusExpirationDate,
    employmentStartDate: d.employmentStartDate,
    hasWorkAuthorization: d.hasWorkAuthorization,
    cardValidTo: d.cardValidTo,
    sponsorIncomeCents: d.sponsorIncomeCents,
    sponsorHouseholdSize: d.sponsorHouseholdSize,
    i864Verdict,
    i693SignedDate: d.i693SignedDate,
    supersededForms: editions.filter((e) => e.editionChangePending).map((e) => e.formCode),
  });
}
