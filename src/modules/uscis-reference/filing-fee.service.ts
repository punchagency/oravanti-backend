import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import {
  filingFeeSchedule,
  povertyGuidelines,
  type FilingFee,
  type PovertyGuideline,
} from "../../db/schema/filing-fees";

/**
 * Fee and income-threshold lookups, both keyed by the date they are asked about.
 *
 * A matter filed in March quotes March's fee, not today's. That is the entire
 * reason these are tables rather than constants, so every lookup here takes the
 * date explicitly rather than reaching for a clock.
 */

export type IsoDate = string;

export interface FeeQuote {
  formCode: string;
  filingMethod: "online" | "paper" | "any";
  context: "standalone" | "with_pending_i485";
  amountCents: number;
  notes: string | null;
}

/** In force on `on` — started, and either open-ended or not yet ended. */
const inForceOn = (fee: Pick<FilingFee, "effectiveFrom" | "effectiveTo">, on: IsoDate) =>
  fee.effectiveFrom <= on && (fee.effectiveTo === null || fee.effectiveTo >= on);

/**
 * Picks the row that applies, from rows already narrowed to one form.
 *
 * Pure, so the precedence rules can be tested without a database.
 *
 * `context` is matched exactly and never falls back: an I-765 filed with a
 * pending I-485 costs $260 and standalone costs $520, so silently falling back
 * to the standalone row would overcharge by double — which is exactly the error
 * the source document made. Filing *method* does fall back to the `any` row,
 * because a form with one price is stored once rather than twice.
 */
export function selectFee(
  rows: FilingFee[],
  params: { filingMethod: "online" | "paper"; context: "standalone" | "with_pending_i485"; on: IsoDate },
): FeeQuote | null {
  const candidates = rows.filter(
    (r) => inForceOn(r, params.on) && r.context === params.context,
  );

  const match =
    candidates.find((r) => r.filingMethod === params.filingMethod) ??
    candidates.find((r) => r.filingMethod === "any") ??
    null;

  if (!match) return null;

  return {
    formCode: match.formCode,
    filingMethod: match.filingMethod,
    context: match.context,
    amountCents: match.amountCents,
    notes: match.notes,
  };
}

/** Every fee in force for a set of forms on a given date. */
export async function quoteFees(params: {
  formCodes: readonly string[];
  filingMethod: "online" | "paper";
  /** Which forms are being filed alongside a pending or concurrent I-485. */
  withPendingI485?: readonly string[];
  /** The matter's filing date, or today for one not yet filed. */
  on: IsoDate;
}): Promise<FeeQuote[]> {
  if (params.formCodes.length === 0) return [];

  const rows = await db
    .select()
    .from(filingFeeSchedule)
    .where(inArray(filingFeeSchedule.formCode, [...params.formCodes]));

  const concurrent = new Set(params.withPendingI485 ?? []);

  return params.formCodes.flatMap((formCode) => {
    const quote = selectFee(
      rows.filter((r) => r.formCode === formCode),
      {
        filingMethod: params.filingMethod,
        context: concurrent.has(formCode) ? "with_pending_i485" : "standalone",
        on: params.on,
      },
    );
    return quote ? [quote] : [];
  });
}

// ── I-864 income threshold ─────────────────────────────────────────────────

export type I864Verdict =
  | { verdict: "meets"; thresholdCents: number; because: string }
  | { verdict: "below"; thresholdCents: number; because: string }
  | { verdict: "unknown"; because: string };

/**
 * Whether a sponsor's income meets the I-864 requirement.
 *
 * `unknown` is a real outcome, not an error path. Alaska and Hawaii have their
 * own tables and are not seeded (see filing-fees.seed.ts), and a threshold that
 * might be a year stale is worse than no threshold: a wrong one silently passes
 * an I-864 that USCIS will RFE, whereas "unknown" puts it in front of a person.
 *
 * The 100% column applies where the sponsor is active-duty military sponsoring a
 * spouse or child; everyone else is measured against 125%.
 */
export function evaluateI864Income(params: {
  rows: PovertyGuideline[];
  householdSize: number;
  sponsorIncomeCents: number;
  isActiveDutyMilitary: boolean;
}): I864Verdict {
  const { rows, householdSize, sponsorIncomeCents } = params;

  if (rows.length === 0) {
    return {
      verdict: "unknown",
      because: "No poverty-guideline table on record for this sponsor's state.",
    };
  }

  if (householdSize < 2) {
    // An I-864 always has at least the sponsor and the intending immigrant.
    return { verdict: "unknown", because: "Household size must be at least 2 for an I-864." };
  }

  const exact = rows.find((r) => r.householdSize === householdSize);
  const largest = rows.reduce((a, b) => (a.householdSize > b.householdSize ? a : b));

  const column = (r: PovertyGuideline) =>
    params.isActiveDutyMilitary ? r.militaryThresholdCents : r.thresholdCents;

  // Beyond the largest published household, the table says to add a fixed amount
  // per additional person rather than publishing an unbounded list.
  const thresholdCents = exact
    ? column(exact)
    : column(largest) + (householdSize - largest.householdSize) * largest.perAdditionalPersonCents;

  const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
  const basis = params.isActiveDutyMilitary
    ? "100% of the poverty guidelines (active-duty military sponsoring a spouse or child)"
    : "125% of the poverty guidelines";

  const meets = sponsorIncomeCents >= thresholdCents;
  return {
    verdict: meets ? "meets" : "below",
    thresholdCents,
    because:
      `A household of ${householdSize} needs ${dollars(thresholdCents)} — ${basis}. ` +
      `Sponsor income is ${dollars(sponsorIncomeCents)}.`,
  };
}

/** The guideline rows for one jurisdiction and year. */
export async function povertyGuidelinesFor(
  jurisdiction: string,
  year: number,
): Promise<PovertyGuideline[]> {
  return db
    .select()
    .from(povertyGuidelines)
    .where(
      and(eq(povertyGuidelines.jurisdiction, jurisdiction), eq(povertyGuidelines.year, year)),
    );
}
