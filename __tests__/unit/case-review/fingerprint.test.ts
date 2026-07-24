import { describe, expect, it } from "@jest/globals";
import {
  computeFingerprint,
  contentHash,
  issueKey,
  type FingerprintInput,
} from "../../../src/modules/case-review/fingerprint";
import {
  normalizeDate,
  normalizeText,
  normalizeValue,
} from "../../../src/modules/case-review/normalize";

describe("normalize", () => {
  it("strips diacritics, lowercases and collapses whitespace", () => {
    expect(normalizeText("José  GARCÍA")).toBe("jose garcia");
    expect(normalizeText("  Jane   Doe ")).toBe("jane doe");
    expect(normalizeText("MÜLLER")).toBe("muller");
  });

  it("normalizes equivalent date formats to ISO", () => {
    expect(normalizeDate("1990-03-12")).toBe("1990-03-12");
    expect(normalizeDate("12 March 1990")).toBe("1990-03-12");
    expect(normalizeDate("March 12, 1990")).toBe("1990-03-12");
    expect(normalizeDate("12 Mar 1990")).toBe("1990-03-12");
  });

  it("is TZ-safe for ISO dates (no day shift)", () => {
    // ISO is sliced, never passed through Date() — so no UTC/local drift.
    expect(normalizeDate("1990-01-01")).toBe("1990-01-01");
    expect(normalizeDate("1990-12-31")).toBe("1990-12-31");
  });

  it("does not treat bare numbers as dates", () => {
    expect(normalizeDate("2020")).toBeNull();
    expect(normalizeDate("12")).toBeNull();
    expect(normalizeDate("A1234567")).toBeNull();
  });

  it("normalizeValue: dates → ISO, text → canonical, null → empty", () => {
    expect(normalizeValue("12 March 1990")).toBe("1990-03-12");
    expect(normalizeValue("José García")).toBe("jose garcia");
    expect(normalizeValue(null)).toBe("");
    expect(normalizeValue(undefined)).toBe("");
    expect(normalizeValue(5)).toBe("5");
  });
});

describe("issueKey", () => {
  const base: FingerprintInput = {
    scenarioId: "case-1",
    issueType: "field_conflict_across_documents",
    field: "date_of_birth",
    documentIds: ["doc-a", "doc-b"],
  };

  it("is independent of document id order", () => {
    expect(issueKey({ ...base, documentIds: ["doc-a", "doc-b"] })).toBe(
      issueKey({ ...base, documentIds: ["doc-b", "doc-a"] }),
    );
  });

  it("differs by scenario, issue type, field, and document set", () => {
    expect(issueKey({ ...base, scenarioId: "case-2" })).not.toBe(issueKey(base));
    expect(issueKey({ ...base, issueType: "photo_mismatch" })).not.toBe(issueKey(base));
    expect(issueKey({ ...base, field: "nationality" })).not.toBe(issueKey(base));
    expect(issueKey({ ...base, documentIds: ["doc-a", "doc-c"] })).not.toBe(issueKey(base));
  });

  it("treats missing field and missing document list consistently", () => {
    expect(issueKey({ scenarioId: "s", issueType: "missing_required_document" })).toBe(
      issueKey({ scenarioId: "s", issueType: "missing_required_document", field: "", documentIds: [] }),
    );
  });
});

describe("contentHash", () => {
  it("is stable across equivalent date formats", () => {
    expect(contentHash({ document_1: "1990-03-12", document_2: "12 March 1990" })).toBe(
      contentHash({ document_1: "12 March 1990", document_2: "1990-03-12" }),
    );
  });

  it("is stable across name diacritics, casing and whitespace", () => {
    expect(contentHash({ name: "José García" })).toBe(contentHash({ name: "jose garcia" }));
    expect(contentHash({ name: "  Jane   DOE " })).toBe(contentHash({ name: "jane doe" }));
  });

  it("is independent of key order", () => {
    expect(contentHash({ a: "1", b: "2" })).toBe(contentHash({ b: "2", a: "1" }));
  });

  it("changes when a value's substance changes", () => {
    expect(contentHash({ dob: "1990-03-12" })).not.toBe(contentHash({ dob: "1991-03-12" }));
  });

  it("normalizes numbers to their string form", () => {
    expect(contentHash({ count: 5 })).toBe(contentHash({ count: "5" }));
  });

  it("empty values hash consistently", () => {
    expect(contentHash({})).toBe(contentHash({}));
  });
});

describe("computeFingerprint — diff semantics", () => {
  const input: FingerprintInput = {
    scenarioId: "case-1",
    issueType: "field_conflict_across_documents",
    field: "date_of_birth",
    documentIds: ["doc-a", "doc-b"],
    salientValues: { "doc-a": "1990-03-12", "doc-b": "1985-01-01" },
  };

  it("unchanged rerun → same key AND same content (preserve resolution)", () => {
    // Same issue, docs re-listed in reverse, DOB written in a different format.
    const rerun = computeFingerprint({
      ...input,
      documentIds: ["doc-b", "doc-a"],
      salientValues: { "doc-a": "12 March 1990", "doc-b": "1985-01-01" },
    });
    const original = computeFingerprint(input);
    expect(rerun.issueKey).toBe(original.issueKey);
    expect(rerun.contentHash).toBe(original.contentHash);
  });

  it("value change → same key, different content (supersede + reopen)", () => {
    const changed = computeFingerprint({
      ...input,
      salientValues: { "doc-a": "1991-03-12", "doc-b": "1985-01-01" },
    });
    const original = computeFingerprint(input);
    expect(changed.issueKey).toBe(original.issueKey);
    expect(changed.contentHash).not.toBe(original.contentHash);
  });

  it("different document set → different key (a distinct issue)", () => {
    const other = computeFingerprint({ ...input, documentIds: ["doc-a", "doc-c"] });
    expect(other.issueKey).not.toBe(computeFingerprint(input).issueKey);
  });
});
