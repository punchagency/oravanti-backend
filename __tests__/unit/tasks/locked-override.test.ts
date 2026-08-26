import { describe, expect, it } from "@jest/globals";
import { lockedOverrideViolation } from "../../../src/modules/tasks/tasks.service";
import { updateTaskBody } from "../../../src/modules/tasks/tasks.validation";

/*
  The locked backbone: a firm may add to a system template freely, but cannot
  weaken a locked step without recording why. `lockedOverrideViolation` is where
  that holds for an individual materialized task.
*/

const locked = { isLocked: true };
const unlocked = { isLocked: false };

const RATIONALE = "Client's treating physician confirmed MMI early; deadline no longer applies.";

describe("lockedOverrideViolation", () => {
  it("waves through any edit to an unlocked task", () => {
    expect(lockedOverrideViolation(unlocked, { dueDate: "2026-01-01" })).toBeNull();
    expect(lockedOverrideViolation(unlocked, { status: "skipped" })).toBeNull();
  });

  it("allows ordinary case work on a locked task without a rationale", () => {
    // Locking protects the deadline, not the row. Working the step is the point.
    expect(lockedOverrideViolation(locked, { status: "in_progress" })).toBeNull();
    expect(lockedOverrideViolation(locked, { status: "completed" })).toBeNull();
    expect(lockedOverrideViolation(locked, { assignedToId: crypto.randomUUID() } as any)).toBeNull();
    expect(lockedOverrideViolation(locked, { notes: "Records requested 3 Mar" })).toBeNull();
  });

  it("blocks moving a locked step's due date", () => {
    expect(lockedOverrideViolation(locked, { dueDate: "2026-01-01" })).toMatch(/dueDate is locked/);
  });

  it("blocks changing a locked step's required certifications", () => {
    expect(lockedOverrideViolation(locked, { requiredCertifications: [] })).toMatch(
      /requiredCertifications is locked/,
    );
  });

  it.each(["skipped", "cancelled"] as const)("blocks marking a locked step %s", (status) => {
    expect(lockedOverrideViolation(locked, { status })).toMatch(new RegExp(status));
  });

  it("permits the same edits once a rationale is given", () => {
    expect(lockedOverrideViolation(locked, { dueDate: "2026-01-01", overrideRationale: RATIONALE })).toBeNull();
    expect(lockedOverrideViolation(locked, { status: "skipped", overrideRationale: RATIONALE })).toBeNull();
  });

  it("names the offending field so the caller knows what to drop", () => {
    expect(lockedOverrideViolation(locked, { title: "Renamed", dueDate: "2026-01-01" })).toContain(
      "dueDate",
    );
  });
});

describe("updateTaskBody rationale", () => {
  it("rejects a token rationale", () => {
    // The whole value of the trail is that someone had to state a reason.
    for (const rationale of ["n/a", "-", "override"]) {
      expect(updateTaskBody.safeParse({ status: "skipped", overrideRationale: rationale }).success).toBe(false);
    }
  });

  it("accepts a real one", () => {
    expect(updateTaskBody.safeParse({ status: "skipped", overrideRationale: RATIONALE }).success).toBe(true);
  });
});
