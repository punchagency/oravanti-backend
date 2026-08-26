import { describe, expect, it } from "@jest/globals";
import { applyOffset } from "../../../src/modules/workflow/due-date-resolver";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("applyOffset", () => {
  it("moves forward for a positive offset", () => {
    expect(applyOffset(d("2026-03-01"), 30)).toBe("2026-03-31");
  });

  it("moves backward for a negative offset", () => {
    // PI Module 1's SOL cascade: -180 / -90 / -30 off statute_of_limitations_date.
    expect(applyOffset(d("2026-06-30"), -180)).toBe("2026-01-01");
    expect(applyOffset(d("2026-06-30"), -90)).toBe("2026-04-01");
    expect(applyOffset(d("2026-06-30"), -30)).toBe("2026-05-31");
  });

  it("lands on the anchor for an offset of zero", () => {
    expect(applyOffset(d("2026-03-01"), 0)).toBe("2026-03-01");
  });

  it("crosses month and year boundaries", () => {
    expect(applyOffset(d("2026-12-20"), 20)).toBe("2027-01-09");
    expect(applyOffset(d("2027-01-09"), -20)).toBe("2026-12-20");
  });

  it("handles a leap day", () => {
    expect(applyOffset(d("2028-02-28"), 1)).toBe("2028-02-29");
    expect(applyOffset(d("2027-02-28"), 1)).toBe("2027-03-01");
  });

  it("handles PI's 3-year government pre-suit notice offset", () => {
    // Module 2: incident_date +1095.
    expect(applyOffset(d("2026-01-01"), 1095)).toBe("2028-12-31");
  });
});
