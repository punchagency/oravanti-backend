import { sql } from "drizzle-orm";
import { db } from "../client";
import { filingFeeSchedule, povertyGuidelines, type NewFilingFee } from "../schema/filing-fees";

/**
 * USCIS filing fees, and the I-864 income thresholds.
 *
 * Both are versioned by effective date so a matter keeps quoting the figure that
 * actually applied to it. Nothing here is duplicated in code — that rule is the
 * whole point, and the I-765 below is the proof of why.
 *
 * Verified 25 Aug 2026.
 */

const VERIFIED_ON = "2026-08-25";
const FEE_RULE_URL = "https://www.uscis.gov/g-1055";

/**
 * The fees set by the 1 April 2024 USCIS fee rule, still in force.
 *
 * The I-765 is the row worth reading twice. Filed on its own it is $470 online
 * or $520 on paper; filed while an I-485 is pending — which is what every
 * concurrent AOS package does — it is **$260**. The source document quoted only
 * the standalone figure, which misquotes the most commonly bundled form in the
 * practice area by roughly double.
 */
const FEES: Omit<NewFilingFee, "id" | "createdAt">[] = [
  {
    formCode: "I-130",
    filingMethod: "online",
    context: "standalone",
    amountCents: 62_500,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes: "Petitioner pays. No fee waiver available for I-130.",
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-130",
    filingMethod: "paper",
    context: "standalone",
    amountCents: 67_500,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes: "Petitioner pays. No fee waiver available for I-130.",
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-485",
    filingMethod: "paper",
    context: "standalone",
    amountCents: 144_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes: "Biometrics are bundled into this fee — there is no separate $85 charge.",
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-765",
    filingMethod: "any",
    context: "with_pending_i485",
    amountCents: 26_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes:
      "The concurrent-filing rate. Quoting the standalone $470/$520 here overcharges the client by roughly double.",
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-765",
    filingMethod: "online",
    context: "standalone",
    amountCents: 47_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-765",
    filingMethod: "paper",
    context: "standalone",
    amountCents: 52_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
  {
    formCode: "I-131",
    filingMethod: "paper",
    context: "standalone",
    amountCents: 63_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes: "Advance parole. Paper filing is typical for the AOS package.",
    sourceUrl: FEE_RULE_URL,
    verifiedOn: VERIFIED_ON,
  },
];

/**
 * 2026 HHS poverty guidelines, 48 contiguous states + DC only.
 *
 * ─── Why Alaska and Hawaii are deliberately absent ──────────────────────────
 *
 * They have their own, higher tables, and the two secondary sources checked on
 * 25 Aug 2026 disagreed materially about them — $51,563 vs $50,237 for an Alaska
 * household of four. One of them is last year's table, and there is no way to
 * tell which from the outside.
 *
 * Seeding a figure that might be a year stale would be worse than seeding none:
 * `evaluateI864Income` refuses to judge a jurisdiction it has no row for and
 * says so, whereas a wrong threshold silently passes an I-864 that USCIS will
 * RFE. Add AK and HI from the official Form I-864P, not from a summary.
 */
const CONTIGUOUS_2026 = {
  year: 2026,
  jurisdiction: "48",
  effectiveFrom: "2026-03-01",
  sourceUrl: "https://www.uscis.gov/i-864p",
  /** householdSize → [100% cents, 125% cents]. */
  rows: {
    2: [2_164_000, 2_705_000],
    3: [2_732_000, 3_415_000],
    4: [3_300_000, 4_125_000],
    5: [3_868_000, 4_835_000],
    6: [4_436_000, 5_545_000],
    7: [5_004_000, 6_255_000],
    8: [5_572_000, 6_965_000],
  } as Record<number, [number, number]>,
  perAdditional: [568_000, 710_000] as [number, number],
};

export async function seedFilingFees(): Promise<void> {
  for (const fee of FEES) {
    await db
      .insert(filingFeeSchedule)
      .values(fee)
      .onConflictDoUpdate({
        target: [
          filingFeeSchedule.formCode,
          filingFeeSchedule.filingMethod,
          filingFeeSchedule.context,
          filingFeeSchedule.effectiveFrom,
        ],
        set: {
          amountCents: sql`excluded.amount_cents`,
          effectiveTo: sql`excluded.effective_to`,
          notes: sql`excluded.notes`,
          sourceUrl: sql`excluded.source_url`,
          verifiedOn: sql`excluded.verified_on`,
        },
      });
  }

  for (const [size, [military, threshold]] of Object.entries(CONTIGUOUS_2026.rows)) {
    await db
      .insert(povertyGuidelines)
      .values({
        year: CONTIGUOUS_2026.year,
        jurisdiction: CONTIGUOUS_2026.jurisdiction,
        householdSize: Number(size),
        thresholdCents: threshold,
        militaryThresholdCents: military,
        perAdditionalPersonCents: CONTIGUOUS_2026.perAdditional[1],
        effectiveFrom: CONTIGUOUS_2026.effectiveFrom,
        sourceUrl: CONTIGUOUS_2026.sourceUrl,
      })
      .onConflictDoUpdate({
        target: [
          povertyGuidelines.year,
          povertyGuidelines.jurisdiction,
          povertyGuidelines.householdSize,
        ],
        set: {
          thresholdCents: sql`excluded.threshold_cents`,
          militaryThresholdCents: sql`excluded.military_threshold_cents`,
          perAdditionalPersonCents: sql`excluded.per_additional_person_cents`,
          effectiveFrom: sql`excluded.effective_from`,
          sourceUrl: sql`excluded.source_url`,
        },
      });
  }

  console.log(
    `Seeded ${FEES.length} filing fees and ` +
      `${Object.keys(CONTIGUOUS_2026.rows).length} poverty-guideline rows (48 states + DC).`,
  );
}
