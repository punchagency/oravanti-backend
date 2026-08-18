import { describe, expect, it } from "@jest/globals";
import {
  money,
  num,
  numOrNull,
  rate,
  round,
  toMoney,
  toRate,
  trustFirstSplit,
} from "../../../src/modules/finance/money";

describe("num / numOrNull", () => {
  it("parses the strings Postgres numeric returns", () => {
    expect(num("1440.0000")).toBe(1440);
    expect(num("0.0001")).toBe(0.0001);
    expect(num("-25.50")).toBe(-25.5);
  });

  it("reads absent values as zero, but numOrNull preserves the distinction", () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull("0")).toBe(0);
  });

  it("does not let a malformed value become NaN downstream", () => {
    expect(num("not-a-number")).toBe(0);
    expect(numOrNull("not-a-number")).toBeNull();
  });
});

describe("round", () => {
  it("rounds half UP, including for negatives", () => {
    expect(round(0.5, 0)).toBe(1);
    // Math.round(-0.5) is -0, which would silently lose a cent on a credit.
    expect(round(-0.5, 0)).toBe(-1);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(-2.675, 2)).toBe(-2.68);
  });

  it("survives the binary-float cases that trip naive rounding", () => {
    // 1.005 is really 1.00499999999999989 in IEEE-754.
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(1.115, 2)).toBe(1.12);
  });
});

describe("toMoney / toRate", () => {
  it("bills to 2dp and keeps rate precision at 4dp", () => {
    expect(toMoney(10.129)).toBe(10.13);
    expect(toRate(0.12345)).toBe(0.1235);
  });

  it("formats for the numeric column at the right scale", () => {
    expect(money(1440)).toBe("1440.00");
    expect(money(10.129)).toBe("10.13");
    expect(rate(0.12345)).toBe("0.1235");
  });
});

describe("trustFirstSplit", () => {
  it("fills trust before operating", () => {
    // The rule the processor uses. Pro-rata would have given 450/150 here; the
    // whole point is that trust is satisfied first.
    const split = trustFirstSplit(600, 500, 1500);
    expect(split.trust).toBe(600);
    expect(split.operating).toBe(0);
  });

  it("spills into operating once trust is covered", () => {
    // 1000 against 400 owed to trust: trust takes its 400, operating gets the
    // rest. This is the case that proves it is trust-FIRST, not trust-only.
    expect(trustFirstSplit(1000, 900, 400)).toEqual({
      operating: 600,
      trust: 400,
    });
  });

  it("always sums exactly to the payment, so the check constraint holds", () => {
    const split = trustFirstSplit(100, 333, 667);
    expect(toMoney(split.operating + split.trust)).toBe(100);
  });

  it("attributes to operating when nothing is outstanding", () => {
    // An overpayment on a settled invoice: it is firm revenue, not client money.
    expect(trustFirstSplit(50, 0, 0)).toEqual({ operating: 50, trust: 0 });
  });

  it("attributes to operating when only operating is owed", () => {
    expect(trustFirstSplit(200, 1000, 0)).toEqual({ operating: 200, trust: 0 });
  });

  it("sends the whole payment to trust when trust owes more than the payment", () => {
    expect(trustFirstSplit(200, 0, 1000)).toEqual({ operating: 0, trust: 200 });
  });

  it("never apportions more trust than the payment itself", () => {
    const split = trustFirstSplit(10, 0, 100000);
    expect(split.trust).toBeLessThanOrEqual(10);
    expect(split.operating).toBeGreaterThanOrEqual(0);
  });

  it("accumulates trust-first across successive partial payments", () => {
    // What Confido does cumulatively: each payment sees the REMAINING trust
    // outstanding, so trust keeps filling rather than each payment re-splitting.
    const first = trustFirstSplit(200, 1500, 500);
    expect(first).toEqual({ operating: 0, trust: 200 });
    const second = trustFirstSplit(500, 1500, 500 - first.trust);
    expect(second).toEqual({ operating: 200, trust: 300 });
  });
});
});
