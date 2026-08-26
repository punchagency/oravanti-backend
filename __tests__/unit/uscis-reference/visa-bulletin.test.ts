import { describe, expect, it } from "@jest/globals";
import {
  isPriorityDateCurrent,
  selectGoverningCutoff,
  WORLDWIDE,
  type CutoffRow,
} from "../../../src/modules/uscis-reference/visa-bulletin.service";

/*
  Whether a priority date is current decides whether a firm files an I-485 or
  waits. Filing early is a rejection and a lost fee; waiting when the date is
  current can cost a place in a queue that moves once a month.

  So this tests the comparison exhaustively, against fixed rows and no clock.
  Every case below is a way the real bulletin behaves — the two charts, the
  per-country columns, "C" and "U", and the boundary at the cut-off itself.
*/

const row = (o: Partial<CutoffRow> = {}): CutoffRow => ({
  category: "f2a",
  chargeabilityArea: WORLDWIDE,
  chart: "dates_for_filing",
  status: "date",
  cutoffDate: "2024-09-01",
  governsAosFiling: true,
  ...o,
});

describe("selectGoverningCutoff", () => {
  it("ignores a chart USCIS did not accept for AOS filings this month", () => {
    // Both charts are published every month and both are real data. Only the
    // one USCIS names governs a filing, and using the other is the mistake this
    // whole column exists to prevent — the final-action chart is normally the
    // more restrictive, so reading it would delay every filing by months.
    const rows = [
      row({ chart: "final_action", cutoffDate: "2023-01-01", governsAosFiling: false }),
      row({ chart: "dates_for_filing", cutoffDate: "2024-09-01", governsAosFiling: true }),
    ];

    expect(selectGoverningCutoff(rows, "f2a", WORLDWIDE)?.cutoffDate).toBe("2024-09-01");
  });

  it("prefers a country's own column over worldwide", () => {
    // Mexico's F2A column runs years behind worldwide. Serving a Mexican case
    // the worldwide row would report it current long before it is.
    const rows = [
      row({ chargeabilityArea: WORLDWIDE, cutoffDate: "2024-09-01" }),
      row({ chargeabilityArea: "MX", cutoffDate: "2022-03-15" }),
    ];

    expect(selectGoverningCutoff(rows, "f2a", "MX")?.cutoffDate).toBe("2022-03-15");
  });

  it("falls back to worldwide for a country with no column of its own", () => {
    const rows = [row({ chargeabilityArea: WORLDWIDE }), row({ chargeabilityArea: "IN" })];

    expect(selectGoverningCutoff(rows, "f2a", "NG")?.chargeabilityArea).toBe(WORLDWIDE);
  });

  it("returns null rather than a wrong category's cut-off", () => {
    expect(selectGoverningCutoff([row({ category: "f4" })], "f2a", WORLDWIDE)).toBeNull();
  });
});

describe("isPriorityDateCurrent", () => {
  const ask = (o: Partial<Parameters<typeof isPriorityDateCurrent>[0]> = {}) =>
    isPriorityDateCurrent({
      priorityDate: "2024-01-01",
      category: "f2a",
      chargeabilityArea: WORLDWIDE,
      rows: [row()],
      ...o,
    });

  it("treats an immediate relative as current with no cut-off at all", () => {
    // IR is the "not subject to the annual numerical limits" category, so there
    // is nothing to compare against and no queue to wait in. A bulletin lookup
    // here would find no row and wrongly report "not current".
    const result = ask({ category: "ir", priorityDate: null, rows: [] });

    expect(result.current).toBe(true);
    expect(result.because).toContain("numerical limits");
  });

  it("is current when the priority date is before the cut-off", () => {
    expect(ask({ priorityDate: "2024-01-01" }).current).toBe(true);
  });

  it("is not current when the priority date is after the cut-off", () => {
    expect(ask({ priorityDate: "2025-01-01" }).current).toBe(false);
  });

  it("is NOT current when the priority date equals the cut-off", () => {
    /*
      The boundary, and the one worth stating explicitly.

      The bulletin's convention is that a cut-off is the first date not yet
      reached: an applicant whose priority date equals the cut-off is not
      current. Using `<=` here would tell a client to file a month early and
      USCIS would reject the filing.
    */
    expect(ask({ priorityDate: "2024-09-01" }).current).toBe(false);
  });

  it("is current for a 'C' cell whatever the priority date", () => {
    const result = ask({
      priorityDate: "2030-01-01",
      rows: [row({ status: "current", cutoffDate: null })],
    });

    expect(result.current).toBe(true);
  });

  it("is not current for a 'U' cell whatever the priority date", () => {
    // "U" and "C" both have a null cut-off and mean opposite things, which is
    // why the status is stored separately rather than inferred from the date.
    const result = ask({
      priorityDate: "1990-01-01",
      rows: [row({ status: "unavailable", cutoffDate: null })],
    });

    expect(result.current).toBe(false);
    expect(result.because).toContain("unavailable");
  });

  it("refuses to guess when a date row has no date", () => {
    const result = ask({ rows: [row({ status: "date", cutoffDate: null })] });

    expect(result.current).toBe(false);
    expect(result.because).toContain("missing a date");
  });

  it("is not current, with a reason, when the bulletin has no matching row", () => {
    const result = ask({ rows: [row({ category: "f4" })] });

    expect(result.current).toBe(false);
    expect(result.because).toContain("No governing F2A cut-off");
  });

  it("says so plainly when the case has no priority date or category yet", () => {
    expect(ask({ priorityDate: null }).because).toContain("No priority date");
    expect(ask({ category: null }).because).toContain("No preference category");
  });

  it("treats a missing chargeability area as worldwide", () => {
    // The column is nullable and intake often fills it in late. Defaulting to
    // worldwide matches what the bulletin itself does for countries without a
    // column, and is the only defensible default.
    const result = ask({ chargeabilityArea: null, priorityDate: "2024-01-01" });

    expect(result.current).toBe(true);
  });

  it("uses a country's own, more restrictive column when it has one", () => {
    const rows = [
      row({ chargeabilityArea: WORLDWIDE, cutoffDate: "2024-09-01" }),
      row({ chargeabilityArea: "IN", cutoffDate: "2013-06-01" }),
    ];

    expect(ask({ chargeabilityArea: WORLDWIDE, rows }).current).toBe(true);
    expect(ask({ chargeabilityArea: "IN", rows }).current).toBe(false);
  });

  it("gives a reason on every path, because the answer is written to a case", () => {
    const paths = [
      ask(),
      ask({ category: "ir" }),
      ask({ priorityDate: null }),
      ask({ category: null }),
      ask({ rows: [] }),
      ask({ rows: [row({ status: "current", cutoffDate: null })] }),
      ask({ rows: [row({ status: "unavailable", cutoffDate: null })] }),
    ];

    for (const result of paths) {
      expect(result.because.length).toBeGreaterThan(0);
      expect(result.because).toMatch(/\.$/);
    }
  });
});
