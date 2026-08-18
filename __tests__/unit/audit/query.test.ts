import { describe, expect, it } from "@jest/globals";
import { decodeCursor } from "../../../src/modules/audit/audit.service";

/**
 * The keyset cursor.
 *
 * Pure and DB-free, so it needs no mocking — the query it feeds is exercised
 * against a real database in the integration project. What is asserted here is
 * the half that fails silently: a cursor that decodes to *almost* the right
 * thing pages past events instead of erroring, which is the failure mode the
 * whole keyset design exists to prevent.
 */

/** Mirrors the private encoder — kept here so a change to the format fails loudly. */
const encode = (iso: string, id: string) =>
  Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");

describe("decodeCursor", () => {
  it("round-trips a timestamp and an id", () => {
    const iso = "2026-08-18T09:41:22.123Z";
    const id = "0f8c0d1e-2b3a-4c5d-8e9f-a0b1c2d3e4f5";

    const decoded = decodeCursor(encode(iso, id));

    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(id);
    expect(decoded!.occurredAt.toISOString()).toBe(iso);
  });

  it("keeps millisecond precision", () => {
    // Two events in the same millisecond are exactly the case the id tiebreak
    // exists for; losing the milliseconds would make the tiebreak fire far more
    // often and reorder the page.
    const decoded = decodeCursor(encode("2026-08-18T09:41:22.007Z", "a"));
    expect(decoded!.occurredAt.getMilliseconds()).toBe(7);
  });

  it.each([
    ["not base64 at all", "!!!!"],
    ["base64 with no separator", Buffer.from("nopipe").toString("base64url")],
    ["an empty id", encode("2026-08-18T09:41:22.123Z", "")],
    ["an empty timestamp", encode("", "some-id")],
    ["an unparseable timestamp", encode("the day before yesterday", "some-id")],
    ["an empty string", ""],
  ])("returns null for %s", (_label, raw) => {
    // Null, never a throw: a stale or hand-edited cursor should quietly read
    // page one, not turn the audit screen into a 500.
    expect(decodeCursor(raw)).toBeNull();
  });

  it("does not throw on any of the malformed inputs", () => {
    for (const raw of ["", "!!!", "%%%%", "a".repeat(500)]) {
      expect(() => decodeCursor(raw)).not.toThrow();
    }
  });
});
