import { describe, expect, it } from "@jest/globals";
import { applyOffset } from "../../../src/modules/workflow/due-date-resolver";
import { SYSTEM_TEMPLATES } from "../../../src/db/seeds/workflow-template.seed";

/*
  The I-751 joint-filing window, asserted against the seed that ships it.

  This is the narrowest deadline in the whole AOS template and the one with the
  worst consequence for missing it. The window opens exactly 90 days before the
  conditional card expires and closes ON the expiration date. File before it and
  USCIS rejects; file after it and conditional resident status terminates
  automatically, removal proceedings follow, and there is no grace period — a
  late filing needs documented extraordinary circumstances.

  Both ends are anchored on `green_card_expiration_date`, which had no backing
  column at all until 0017. Every step in this module resolved to null, so the
  window that cannot be missed was the window with no dates on it.
*/

const MODULE_NAME = "I-751 Removal of Conditions";

const i751Module = () => {
  const mod = SYSTEM_TEMPLATES.adjustmentOfStatus.modules.find((m) => m.name === MODULE_NAME);
  if (!mod) throw new Error(`No module named "${MODULE_NAME}"`);
  return mod;
};

const stepAt = (orderIndex: number) => {
  const step = i751Module().steps.find((s) => s.orderIndex === orderIndex);
  if (!step) throw new Error(`No I-751 step at orderIndex ${orderIndex}`);
  return step;
};

describe("the I-751 module is gated on conditional residence", () => {
  it("only opens for a case approved with a two-year card", () => {
    // A 10-year card never enters this stage. Materializing these steps on every
    // matter would put an unmissable deadline on cases that do not have one.
    expect(i751Module().activationType).toBe("conditional");
    expect(i751Module().activationCondition).toEqual({
      field: "immigrationDetails.isConditionalResidence",
      op: "eq",
      value: true,
    });
  });
});

describe("both ends of the filing window are seeded", () => {
  it("opens the window 90 days before the card expires", () => {
    const open = stepAt(1);

    expect(open.dueDateAnchor).toBe("green_card_expiration_date");
    expect(open.dueDateOffsetDays).toBe(-90);
    expect(open.isLocked).toBe(true);
  });

  it("closes the window on the expiration date itself", () => {
    // Offset 0, not -1 and not +1. The expiration date is the last day the
    // filing is accepted, so the deadline lands exactly on it.
    const close = stepAt(2);

    expect(close.dueDateAnchor).toBe("green_card_expiration_date");
    expect(close.dueDateOffsetDays).toBe(0);
    expect(close.isLocked).toBe(true);
  });

  it("locks both, because neither is a step anyone may skip", () => {
    expect(i751Module().steps.every((s) => s.isLocked)).toBe(true);
  });
});

describe("the window resolves to the right two dates", () => {
  const expiration = new Date("2027-06-15T00:00:00.000Z");

  it("puts the closing deadline exactly on the expiration date", () => {
    expect(applyOffset(expiration, stepAt(2).dueDateOffsetDays!)).toBe("2027-06-15");
  });

  it("puts the opening deadline exactly 90 days earlier", () => {
    expect(applyOffset(expiration, stepAt(1).dueDateOffsetDays!)).toBe("2027-03-17");
  });

  it("spans exactly 90 days", () => {
    const open = new Date(`${applyOffset(expiration, stepAt(1).dueDateOffsetDays!)}T00:00:00.000Z`);
    const close = new Date(`${applyOffset(expiration, stepAt(2).dueDateOffsetDays!)}T00:00:00.000Z`);
    const days = (close.getTime() - open.getTime()) / 86_400_000;

    expect(days).toBe(90);
  });

  it("crosses a leap day without drifting", () => {
    // 2028 is a leap year. Date arithmetic that counts in months rather than
    // days would land a day out here, on a deadline with no grace period.
    const leapYearExpiry = new Date("2028-05-01T00:00:00.000Z");

    expect(applyOffset(leapYearExpiry, 0)).toBe("2028-05-01");
    expect(applyOffset(leapYearExpiry, -90)).toBe("2028-02-01");
  });
});
