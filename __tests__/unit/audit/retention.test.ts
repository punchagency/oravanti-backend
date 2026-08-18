import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_ACCESS_RETENTION_YEARS,
  DEFAULT_AUDIT_RETENTION_YEARS,
  resolveWindow,
} from "../../../src/modules/shared/audit-retention.service";

/**
 * The retention window a firm actually gets.
 *
 * Pure, and deliberately the only part of the retention job under unit test:
 * the delete itself needs a real database and a role that RLS applies to, which
 * is what `npm run check 07-rls` is for. What can go wrong here without anyone
 * noticing is the arithmetic — a firm's configuration silently *shortening* a
 * legally-mandated window destroys records that cannot be recovered, and the
 * job would report success.
 */

const meta = (value: unknown) => JSON.stringify(value);

describe("resolveWindow", () => {
  it("falls back to the platform default when there is no metadata", () => {
    expect(resolveWindow(null, "auditRetentionYears", DEFAULT_AUDIT_RETENTION_YEARS)).toBe(
      DEFAULT_AUDIT_RETENTION_YEARS,
    );
  });

  it("honours a firm that wants to keep records longer", () => {
    expect(
      resolveWindow(meta({ auditRetentionYears: 10 }), "auditRetentionYears", 7),
    ).toBe(10);
  });

  it("refuses to shorten below the default", () => {
    // The important one. A firm configuring two years does not get to have
    // seven-year records deleted after two — the floor is not negotiable.
    expect(
      resolveWindow(meta({ auditRetentionYears: 2 }), "auditRetentionYears", 7),
    ).toBe(7);
  });

  it("reads the access window independently of the audit window", () => {
    const metadata = meta({ auditRetentionYears: 10, accessRetentionYears: 3 });

    expect(resolveWindow(metadata, "auditRetentionYears", 7)).toBe(10);
    expect(
      resolveWindow(metadata, "accessRetentionYears", DEFAULT_ACCESS_RETENTION_YEARS),
    ).toBe(3);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an empty string", ""],
    ["a JSON array", "[]"],
    ["the key absent", meta({ somethingElse: 1 })],
    ["a null value", meta({ auditRetentionYears: null })],
    ["a non-numeric string", meta({ auditRetentionYears: "forever" })],
    ["zero", meta({ auditRetentionYears: 0 })],
    ["a negative number", meta({ auditRetentionYears: -5 })],
    ["Infinity as a string", meta({ auditRetentionYears: "Infinity" })],
  ])("falls back to the default for %s", (_label, metadata) => {
    // Every one of these must produce the default rather than 0, NaN or
    // Infinity. A NaN cutoff makes the comparison false and purges nothing —
    // survivable. A 0 cutoff purges everything, which is not.
    expect(resolveWindow(metadata, "auditRetentionYears", 7)).toBe(7);
  });

  it("accepts a numeric string, since JSON metadata is hand-edited", () => {
    expect(
      resolveWindow(meta({ auditRetentionYears: "12" }), "auditRetentionYears", 7),
    ).toBe(12);
  });

  it("keeps the defaults at the legal-practice baseline", () => {
    // Guards against someone lowering these while chasing table size.
    expect(DEFAULT_AUDIT_RETENTION_YEARS).toBeGreaterThanOrEqual(7);
    expect(DEFAULT_ACCESS_RETENTION_YEARS).toBeGreaterThanOrEqual(2);
  });
});
