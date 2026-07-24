import { describe, expect, it } from "@jest/globals";
import { contentHash } from "../../../src/modules/case-review/fingerprint";
import { runRules } from "../../../src/modules/case-review/rule-registry";
import type {
  Requirement,
  RuleContext,
  ScenarioDocument,
} from "../../../src/modules/case-review/types";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const base = (o: Partial<RuleContext> = {}): RuleContext => ({
  scenario: { type: "case", id: "c1", organizationId: "org", clientId: "cl1" },
  now: NOW,
  documents: [],
  requirements: [],
  deadlines: { interviewDate: null, filingDeadline: null, filingSubmitted: false },
  conflicts: [],
  photoComparisons: [],
  config: { crossCheckingEnabled: true, photoComparisonEnabled: true },
  ...o,
});
const only = (ctx: RuleContext, t: string) =>
  runRules(ctx).filter((c) => c.issueType === t);

const req = (o: Partial<Requirement> = {}): Requirement => ({
  id: "r1",
  label: "I-693 Medical Exam",
  documentTypeSlug: "medical_record",
  isRequired: true,
  satisfiedByDocumentId: null,
  waivedAt: null,
  effectiveDueDate: null,
  ...o,
});
const doc = (o: Partial<ScenarioDocument> = {}): ScenarioDocument => ({
  documentId: "d1",
  checksum: "ck1",
  title: "Passport",
  documentType: "passport",
  extractedFields: {},
  hasPhoto: true,
  authenticityVerdict: "genuine",
  authenticityConfidence: 0.9,
  ...o,
});

describe("missing_required_document", () => {
  it("fires only for required, unsatisfied, unwaived requirements", () => {
    expect(only(base({ requirements: [req()] }), "missing_required_document")).toHaveLength(1);
    expect(only(base({ requirements: [req({ satisfiedByDocumentId: "x" })] }), "missing_required_document")).toHaveLength(0);
    expect(only(base({ requirements: [req({ waivedAt: NOW })] }), "missing_required_document")).toHaveLength(0);
    expect(only(base({ requirements: [req({ isRequired: false })] }), "missing_required_document")).toHaveLength(0);
  });

  it("escalates severity as the due date nears, without changing identity", () => {
    const near = only(base({ requirements: [req({ effectiveDueDate: d("2026-06-03") })] }), "missing_required_document")[0];
    const far = only(base({ requirements: [req({ effectiveDueDate: d("2026-08-01") })] }), "missing_required_document")[0];
    expect(near.severity).toBe("critical");
    expect(near.severity).not.toBe(far.severity);
    // Escalation must not supersede: content hash is identical.
    expect(contentHash(near.salientValues)).toBe(contentHash(far.salientValues));
  });
});

describe("document_expiry_before_deadline", () => {
  const withInterview = (expiry: string) =>
    only(
      base({
        deadlines: { interviewDate: d("2026-06-22"), filingDeadline: null, filingSubmitted: false },
        documents: [doc({ extractedFields: { expiry_date: expiry } })],
      }),
      "document_expiry_before_deadline",
    );

  it("needs a scheduled interview to compare against", () => {
    expect(only(base({ documents: [doc({ extractedFields: { expiry_date: "2026-08-01" } })] }), "document_expiry_before_deadline")).toHaveLength(0);
  });
  it("fires (high) when expiry falls within 6 months of the interview", () => {
    const c = withInterview("2026-08-01");
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe("high");
  });
  it("is critical when expiry precedes the interview itself", () => {
    expect(withInterview("2026-06-10")[0].severity).toBe("critical");
  });
  it("is silent when validity extends well beyond the threshold", () => {
    expect(withInterview("2028-01-01")).toHaveLength(0);
  });
});

describe("deadline and filing rules", () => {
  it("deadline_approaching_incomplete fires only when near AND incomplete", () => {
    const near = { interviewDate: null, filingDeadline: d("2026-06-10"), filingSubmitted: false };
    expect(only(base({ deadlines: near, requirements: [req()] }), "deadline_approaching_incomplete")).toHaveLength(1);
    expect(only(base({ deadlines: near, requirements: [req({ satisfiedByDocumentId: "x" })] }), "deadline_approaching_incomplete")).toHaveLength(0);
    const far = { interviewDate: null, filingDeadline: d("2026-12-31"), filingSubmitted: false };
    expect(only(base({ deadlines: far, requirements: [req()] }), "deadline_approaching_incomplete")).toHaveLength(0);
  });
  it("filing_not_marked_submitted fires only when near and unfiled", () => {
    expect(only(base({ deadlines: { interviewDate: null, filingDeadline: d("2026-06-05"), filingSubmitted: false } }), "filing_not_marked_submitted")).toHaveLength(1);
    expect(only(base({ deadlines: { interviewDate: null, filingDeadline: d("2026-06-05"), filingSubmitted: true } }), "filing_not_marked_submitted")).toHaveLength(0);
  });
});

describe("AI conflict rules", () => {
  const conf = (o: Record<string, unknown> = {}) => ({
    field: "date_of_birth",
    participants: ["d1", "d2"],
    values: { d1: "1990-03-12", d2: "1985-01-01" },
    verdict: "conflict",
    explanation: "",
    ...o,
  });

  it("cross-document identity conflict is critical with both docs", () => {
    const c = only(base({ conflicts: [conf()] }), "field_conflict_across_documents");
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe("critical");
    expect(c[0].documentIds).toHaveLength(2);
  });
  it("a name conflict is high, not critical", () => {
    expect(only(base({ conflicts: [conf({ field: "full_name" })] }), "field_conflict_across_documents")[0].severity).toBe("high");
  });
  it("is gated by crossCheckingEnabled", () => {
    expect(only(base({ conflicts: [conf()], config: { crossCheckingEnabled: false, photoComparisonEnabled: true } }), "field_conflict_across_documents")).toHaveLength(0);
  });
  it("scenario-record conflict excludes the record from documentIds and isn't a cross-doc conflict", () => {
    const ctx = base({ conflicts: [conf({ participants: ["d1", "scenario_record"] })] });
    const rec = only(ctx, "field_conflict_with_scenario_record");
    expect(rec).toHaveLength(1);
    expect(rec[0].documentIds).toEqual(["d1"]);
    expect(only(ctx, "field_conflict_across_documents")).toHaveLength(0);
  });
});

describe("image-judgment rules (severity capped at medium)", () => {
  it("photo_mismatch fires at medium, gated and only on mismatch", () => {
    const mismatch = { documentA: "d1", documentB: "d2", verdict: "mismatch" as const, confidence: 0.7 };
    const c = only(base({ photoComparisons: [mismatch] }), "photo_mismatch");
    expect(c).toHaveLength(1);
    expect(c[0].severity).toBe("medium");
    expect(only(base({ photoComparisons: [{ ...mismatch, verdict: "match" }] }), "photo_mismatch")).toHaveLength(0);
    expect(only(base({ photoComparisons: [mismatch], config: { crossCheckingEnabled: true, photoComparisonEnabled: false } }), "photo_mismatch")).toHaveLength(0);
  });
  it("document_authenticity_suspect fires at medium only when suspect", () => {
    expect(only(base({ documents: [doc({ authenticityVerdict: "suspect" })] }), "document_authenticity_suspect")[0].severity).toBe("medium");
    expect(only(base({ documents: [doc({ authenticityVerdict: "genuine" })] }), "document_authenticity_suspect")).toHaveLength(0);
  });
});
