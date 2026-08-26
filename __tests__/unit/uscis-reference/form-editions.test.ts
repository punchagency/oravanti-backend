import { describe, expect, it } from "@jest/globals";
import {
  selectPackageEditions,
  type EditionWindow,
} from "../../../src/modules/uscis-reference/form-edition.service";

/**
 * The I-485 transition these tests are built around is the real one: USCIS
 * rejects the 01/20/25 edition for anything postmarked on or after 2026-09-18,
 * with no grace period. Getting the boundary wrong by a day produces a rejected
 * filing, so the boundary is pinned here explicitly.
 */
const I485: EditionWindow[] = [
  { formCode: "I-485", editionDate: "2025-01-20", acceptedFrom: "2025-01-20", acceptedUntil: "2026-09-17" },
  { formCode: "I-485", editionDate: "2026-09-18", acceptedFrom: "2026-09-18", acceptedUntil: null },
];

const check = (filingDate: string, today: string, rows: EditionWindow[] = I485) =>
  selectPackageEditions({ rows, formCodes: ["I-485"], filingDate, today })[0];

describe("selectPackageEditions", () => {
  it("names the edition in force on the filing date, not today", () => {
    // Drafted in August, filed after the switchover: must use the new edition.
    expect(check("2026-09-20", "2026-08-25").requiredEditions).toEqual(["2026-09-18"]);
  });

  it("flags that the edition changes between today and filing", () => {
    expect(check("2026-09-20", "2026-08-25").editionChangePending).toBe(true);
  });

  it("does not flag a change when filing before the switchover", () => {
    const result = check("2026-09-01", "2026-08-25");
    expect(result.requiredEditions).toEqual(["2025-01-20"]);
    expect(result.editionChangePending).toBe(false);
  });

  it("treats the boundary dates exactly as USCIS states them", () => {
    // Last day the old edition is accepted, first day it is not.
    expect(check("2026-09-17", "2026-09-17").requiredEditions).toEqual(["2025-01-20"]);
    expect(check("2026-09-18", "2026-09-18").requiredEditions).toEqual(["2026-09-18"]);
  });

  it("returns both editions while a grace period overlaps them, newest first", () => {
    const withGrace: EditionWindow[] = [
      { formCode: "I-485", editionDate: "2025-01-20", acceptedFrom: "2025-01-20", acceptedUntil: "2026-10-31" },
      { formCode: "I-485", editionDate: "2026-09-18", acceptedFrom: "2026-09-18", acceptedUntil: null },
    ];
    expect(check("2026-10-01", "2026-10-01", withGrace).requiredEditions).toEqual([
      "2026-09-18",
      "2025-01-20",
    ]);
  });

  it("reports an unknown form as empty rather than as satisfied", () => {
    // A missing row and a passing check must not look alike to the caller.
    const result = selectPackageEditions({
      rows: I485,
      formCodes: ["I-864"],
      filingDate: "2026-09-20",
      today: "2026-08-25",
    })[0];
    expect(result.requiredEditions).toEqual([]);
    expect(result.editionChangePending).toBe(false);
  });

  it("keeps one entry per requested form, in the order asked", () => {
    const result = selectPackageEditions({
      rows: I485,
      formCodes: ["I-130", "I-485"],
      filingDate: "2026-09-20",
      today: "2026-08-25",
    });
    expect(result.map((r) => r.formCode)).toEqual(["I-130", "I-485"]);
  });
});
