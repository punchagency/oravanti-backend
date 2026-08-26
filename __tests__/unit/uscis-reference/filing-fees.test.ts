import { describe, expect, it } from "@jest/globals";
import {
  evaluateI864Income,
  selectFee,
} from "../../../src/modules/uscis-reference/filing-fee.service";
import type { FilingFee, PovertyGuideline } from "../../../src/db/schema/filing-fees";

/*
  Both of these produce a number a client is told. The failure modes are a
  misquoted fee and an I-864 waved through below the threshold, and neither
  announces itself — the first shows up as an angry client, the second as an RFE
  months later.
*/

const fee = (o: Partial<FilingFee> = {}): FilingFee =>
  ({
    id: "x",
    formCode: "I-765",
    filingMethod: "any",
    context: "standalone",
    amountCents: 52_000,
    effectiveFrom: "2024-04-01",
    effectiveTo: null,
    notes: null,
    sourceUrl: null,
    verifiedOn: null,
    createdAt: new Date(),
    ...o,
  }) as FilingFee;

describe("selectFee", () => {
  it("charges the concurrent rate for an I-765 filed with a pending I-485", () => {
    // $260 vs $520 — the error the source document made, and the most commonly
    // bundled form in the practice area.
    const rows = [
      fee({ context: "standalone", filingMethod: "paper", amountCents: 52_000 }),
      fee({ context: "with_pending_i485", filingMethod: "any", amountCents: 26_000 }),
    ];

    const quote = selectFee(rows, {
      filingMethod: "paper",
      context: "with_pending_i485",
      on: "2026-08-25",
    });

    expect(quote?.amountCents).toBe(26_000);
  });

  it("never falls back from the concurrent context to the standalone price", () => {
    // Falling back here would double the quote. Returning nothing is the safe
    // failure: no fee shown beats a wrong fee shown.
    const rows = [fee({ context: "standalone", amountCents: 52_000 })];

    expect(
      selectFee(rows, { filingMethod: "paper", context: "with_pending_i485", on: "2026-08-25" }),
    ).toBeNull();
  });

  it("prefers an exact filing method over the 'any' row", () => {
    const rows = [
      fee({ filingMethod: "any", amountCents: 50_000 }),
      fee({ filingMethod: "online", amountCents: 47_000 }),
    ];

    expect(
      selectFee(rows, { filingMethod: "online", context: "standalone", on: "2026-08-25" })
        ?.amountCents,
    ).toBe(47_000);
  });

  it("falls back to the 'any' row for a form with one price", () => {
    const rows = [fee({ filingMethod: "any", amountCents: 63_000 })];

    expect(
      selectFee(rows, { filingMethod: "online", context: "standalone", on: "2026-08-25" })
        ?.amountCents,
    ).toBe(63_000);
  });

  it("quotes the fee that applied on the filing date, not today's", () => {
    // The whole reason these are versioned rows. A matter filed under the old
    // schedule must keep quoting the old figure.
    const rows = [
      fee({ amountCents: 41_000, effectiveFrom: "2020-01-01", effectiveTo: "2024-03-31" }),
      fee({ amountCents: 52_000, effectiveFrom: "2024-04-01", effectiveTo: null }),
    ];

    const on = (date: string) =>
      selectFee(rows, { filingMethod: "paper", context: "standalone", on: date })?.amountCents;

    expect(on("2023-06-01")).toBe(41_000);
    expect(on("2024-03-31")).toBe(41_000);
    expect(on("2024-04-01")).toBe(52_000);
    expect(on("2026-08-25")).toBe(52_000);
  });
});

// The seeded 48-state 2026 rows, as the table publishes them.
const guideline = (householdSize: number, military: number, threshold: number): PovertyGuideline =>
  ({
    id: `g${householdSize}`,
    year: 2026,
    jurisdiction: "48",
    householdSize,
    thresholdCents: threshold,
    militaryThresholdCents: military,
    perAdditionalPersonCents: 710_000,
    effectiveFrom: "2026-03-01",
    sourceUrl: null,
    createdAt: new Date(),
  }) as PovertyGuideline;

const CONTIGUOUS = [
  guideline(2, 2_164_000, 2_705_000),
  guideline(3, 2_732_000, 3_415_000),
  guideline(4, 3_300_000, 4_125_000),
  guideline(8, 5_572_000, 6_965_000),
];

describe("evaluateI864Income", () => {
  const ask = (o: Partial<Parameters<typeof evaluateI864Income>[0]> = {}) =>
    evaluateI864Income({
      rows: CONTIGUOUS,
      householdSize: 3,
      sponsorIncomeCents: 4_000_000,
      isActiveDutyMilitary: false,
      ...o,
    });

  it("measures a civilian sponsor against the 125% column", () => {
    expect(ask({ sponsorIncomeCents: 3_415_000 }).verdict).toBe("meets");
    expect(ask({ sponsorIncomeCents: 3_414_900 }).verdict).toBe("below");
  });

  it("meets the threshold exactly at the published figure", () => {
    // The requirement is "at least", so equality passes. An off-by-one here
    // would reject a sponsor who qualifies to the dollar.
    const result = ask({ sponsorIncomeCents: 3_415_000 });

    expect(result.verdict).toBe("meets");
    expect(result.thresholdCents === undefined ? null : result.thresholdCents).toBe(3_415_000);
  });

  it("measures an active-duty military sponsor against the 100% column", () => {
    // Sponsoring a spouse or child on active duty drops the requirement to 100%,
    // which is the difference between an approval and an RFE for many sponsors.
    const income = 2_800_000;

    expect(ask({ sponsorIncomeCents: income, isActiveDutyMilitary: false }).verdict).toBe("below");
    expect(ask({ sponsorIncomeCents: income, isActiveDutyMilitary: true }).verdict).toBe("meets");
  });

  it("extends past the largest published household at the per-person rate", () => {
    // 8 = $69,650, +$7,100 per extra person, so 10 = $83,850.
    const result = ask({ householdSize: 10, sponsorIncomeCents: 8_385_000 });

    expect(result.verdict).toBe("meets");
    expect(ask({ householdSize: 10, sponsorIncomeCents: 8_384_900 }).verdict).toBe("below");
  });

  it("returns unknown, not a guess, for a jurisdiction with no table", () => {
    /*
      Alaska and Hawaii are deliberately unseeded: two sources disagreed about
      their 2026 figures and one is presumably last year's. A stale threshold
      silently passes an I-864 USCIS will RFE; "unknown" puts it in front of an
      attorney, which is the correct posture for every § 1.5 rule but the form
      edition.
    */
    const result = ask({ rows: [] });

    expect(result.verdict).toBe("unknown");
    expect(result.because).toContain("No poverty-guideline table");
  });

  it("rejects a household size below two", () => {
    // An I-864 always has at least the sponsor and the intending immigrant.
    expect(ask({ householdSize: 1 }).verdict).toBe("unknown");
  });

  it("always explains itself in figures a person can check", () => {
    const result = ask({ sponsorIncomeCents: 3_000_000 });

    expect(result.because).toContain("$34,150");
    expect(result.because).toContain("$30,000");
  });
});
