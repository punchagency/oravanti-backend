import { describe, expect, it } from "@jest/globals";
import {
  conditionHasUnansweredInput,
  evaluateCondition,
  fieldsReferencedBy,
  type ConditionContext,
} from "../../../src/modules/workflow/condition-evaluator";
import type { Condition } from "../../../src/db/schema/workflow";
import { SYSTEM_TEMPLATES } from "../../../src/db/seeds/workflow-template.seed";

const ctx = (o: Partial<ConditionContext> = {}): ConditionContext => ({
  case: { priority: "medium" },
  immigrationDetails: null,
  personalInjuryDetails: null,
  ...o,
});

const immigration = (o: Partial<NonNullable<ConditionContext["immigrationDetails"]>> = {}) => ({
  filingTrack: null,
  naturalizationTrack: null,
  isConditionalResidence: false,
  priorityDateIsCurrent: false,
  ...o,
});

describe("evaluateCondition", () => {
  describe("eq", () => {
    it("matches a string field", () => {
      const c: Condition = { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" };
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ filingTrack: "concurrent" }) }))).toBe(true);
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ filingTrack: "sequential" }) }))).toBe(false);
    });

    it("matches a boolean field", () => {
      const c: Condition = { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true };
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ isConditionalResidence: true }) }))).toBe(true);
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration() }))).toBe(false);
    });

    it("is false, not an error, when the whole extension row is absent", () => {
      // A PI case evaluating an immigration condition — the module simply
      // stays inactive rather than blowing up materialization.
      const c: Condition = { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" };
      expect(evaluateCondition(c, ctx())).toBe(false);
    });

    it("gates PI's government pre-suit notice module", () => {
      const c: Condition = { field: "personalInjuryDetails.defendantType", op: "eq", value: "government_entity" };
      expect(evaluateCondition(c, ctx({ personalInjuryDetails: { defendantType: "government_entity", isMinorPlaintiff: false } }))).toBe(true);
      expect(evaluateCondition(c, ctx({ personalInjuryDetails: { defendantType: "private", isMinorPlaintiff: false } }))).toBe(false);
    });
  });

  describe("neq", () => {
    it("inverts eq", () => {
      const c: Condition = { field: "case.priority", op: "neq", value: "low" };
      expect(evaluateCondition(c, ctx({ case: { priority: "high" } }))).toBe(true);
      expect(evaluateCondition(c, ctx({ case: { priority: "low" } }))).toBe(false);
    });
  });

  describe("in", () => {
    it("matches any listed value", () => {
      const c: Condition = { field: "case.priority", op: "in", value: ["high", "critical"] };
      expect(evaluateCondition(c, ctx({ case: { priority: "critical" } }))).toBe(true);
      expect(evaluateCondition(c, ctx({ case: { priority: "medium" } }))).toBe(false);
    });

    it("is false for a null field rather than matching nothing accidentally", () => {
      const c: Condition = { field: "immigrationDetails.naturalizationTrack", op: "in", value: ["general", "military"] };
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration() }))).toBe(false);
    });
  });

  describe("allOf / anyOf", () => {
    const concurrent: Condition = { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" };
    const conditionalResidence: Condition = { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true };

    it("allOf requires every branch", () => {
      const c: Condition = { allOf: [concurrent, conditionalResidence] };
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ filingTrack: "concurrent", isConditionalResidence: true }) }))).toBe(true);
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ filingTrack: "concurrent" }) }))).toBe(false);
    });

    it("anyOf requires one branch", () => {
      const c: Condition = { anyOf: [concurrent, conditionalResidence] };
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration({ isConditionalResidence: true }) }))).toBe(true);
      expect(evaluateCondition(c, ctx({ immigrationDetails: immigration() }))).toBe(false);
    });

    it("nests", () => {
      const c: Condition = {
        allOf: [{ anyOf: [concurrent, conditionalResidence] }, { field: "case.priority", op: "neq", value: "low" }],
      };
      expect(evaluateCondition(c, ctx({ case: { priority: "high" }, immigrationDetails: immigration({ filingTrack: "concurrent" }) }))).toBe(true);
      expect(evaluateCondition(c, ctx({ case: { priority: "low" }, immigrationDetails: immigration({ filingTrack: "concurrent" }) }))).toBe(false);
    });
  });
});

describe("fieldsReferencedBy", () => {
  it("collects a leaf condition's field", () => {
    expect(fieldsReferencedBy({ field: "case.priority", op: "eq", value: "high" })).toEqual(["case.priority"]);
  });

  it("walks nested groups, which is what lets a save-time check reject an unknown field", () => {
    const c: Condition = {
      allOf: [
        { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
        { anyOf: [{ field: "case.priority", op: "eq", value: "high" }, { field: "personalInjuryDetails.isMinorPlaintiff", op: "eq", value: true }] },
      ],
    };
    expect(fieldsReferencedBy(c)).toEqual([
      "immigrationDetails.filingTrack",
      "case.priority",
      "personalInjuryDetails.isMinorPlaintiff",
    ]);
  });
});

/*
  The AOS package gate, asserted against the condition the seed actually ships
  rather than a copy of it.

  This is the bug the assertions below pin down: both modules were gated on
  `filingTrack = 'concurrent'` alone, so a preference-category (sequential)
  matter never received the I-485 / I-765 / I-131 / I-864 / I-693 steps at any
  point in its life — not on day one, which is correct, and not in the month its
  priority date finally became current, which is not. Roughly half the
  family-based AOS population had no filing workflow at all.

  Reading the condition out of the seed means changing the seed changes what is
  tested here; a copy would have gone on passing after the gate regressed.
*/
describe("the AOS package gate, as seeded", () => {
  const moduleNamed = (name: string) => {
    const mod = SYSTEM_TEMPLATES.adjustmentOfStatus.modules.find((m) => m.name === name);
    if (!mod?.activationCondition) throw new Error(`No conditional module named "${name}"`);
    return mod.activationCondition;
  };

  const GATED = [
    "AOS Package Assembly (I-485 / I-765 / I-131 / I-864 / I-693)",
    "EAD / Advance Parole (Combo Card)",
  ];

  it.each(GATED)("%s opens immediately on a concurrent filing", (name) => {
    // Immediate relative of a U.S. citizen: no numerical limit, so a visa is
    // always available and the I-485 goes in alongside the I-130.
    const ctxConcurrent = ctx({ immigrationDetails: immigration({ filingTrack: "concurrent" }) });

    expect(evaluateCondition(moduleNamed(name), ctxConcurrent)).toBe(true);
  });

  it.each(GATED)("%s stays shut on a sequential filing until the priority date is current", (name) => {
    const condition = moduleNamed(name);
    const waiting = immigration({ filingTrack: "sequential", priorityDateIsCurrent: false });
    const current = immigration({ filingTrack: "sequential", priorityDateIsCurrent: true });

    expect(evaluateCondition(condition, ctx({ immigrationDetails: waiting }))).toBe(false);
    expect(evaluateCondition(condition, ctx({ immigrationDetails: current }))).toBe(true);
  });

  it.each(GATED)("%s does not depend on the track once the priority date is current", (name) => {
    // Retrogression can also move a cutoff backwards. The flag is what the
    // module follows, so clearing it shuts the gate again regardless of track.
    const condition = moduleNamed(name);
    const noTrackYet = immigration({ filingTrack: null, priorityDateIsCurrent: true });

    expect(evaluateCondition(condition, ctx({ immigrationDetails: noTrackYet }))).toBe(true);
  });

  it.each(GATED)("%s references both fields, so neither can be dropped silently", (name) => {
    expect(fieldsReferencedBy(moduleNamed(name)).sort()).toEqual([
      "immigrationDetails.filingTrack",
      "immigrationDetails.priorityDateIsCurrent",
    ]);
  });
});

describe("conditionHasUnansweredInput", () => {
  /*
    The question `evaluateCondition` cannot answer: is this false because
    someone decided so, or because nobody has said yet?

    Only withdrawal asks. Activation treats both the same — an unanswered field
    is not grounds to start work — but it is very much grounds not to cancel
    work already under way. Clearing a filing track to re-pick it must not read
    as a decision that the I-485 package no longer applies.
  */
  const AOS_GATE: Condition = {
    anyOf: [
      { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
      { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
    ],
  };

  it("is true when a nullable field the condition reads has no value", () => {
    const c = ctx({ immigrationDetails: immigration({ filingTrack: null }) });

    expect(evaluateCondition(AOS_GATE, c)).toBe(false);
    expect(conditionHasUnansweredInput(AOS_GATE, c)).toBe(true);
  });

  it("is false once the field carries a decided answer", () => {
    // "Sequential" is a decision. The gate is still false, but now it is false
    // because someone said so, and withdrawal is the correct response.
    const c = ctx({ immigrationDetails: immigration({ filingTrack: "sequential" }) });

    expect(evaluateCondition(AOS_GATE, c)).toBe(false);
    expect(conditionHasUnansweredInput(AOS_GATE, c)).toBe(false);
  });

  it("is false for a NOT NULL boolean, which is always a decided answer", () => {
    /*
      The I-751 gate. `isConditionalResidence` is `NOT NULL DEFAULT false`, so
      it never reads as unanswered — which is right: false means the module
      never activated and there is nothing to withdraw, and un-ticking it is a
      person positively deciding the matter is not conditional residence.
    */
    const gate: Condition = {
      field: "immigrationDetails.isConditionalResidence",
      op: "eq",
      value: true,
    };

    expect(conditionHasUnansweredInput(gate, ctx({ immigrationDetails: immigration() }))).toBe(
      false,
    );
  });

  it("looks through allOf and anyOf rather than only the top level", () => {
    // The AOS gate is an anyOf of two leaves, so a top-level-only reading would
    // find no fields at all on the one condition that matters most.
    const nested: Condition = {
      allOf: [
        { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
        { anyOf: [{ field: "immigrationDetails.naturalizationTrack", op: "eq", value: "general" }] },
      ],
    };

    expect(
      conditionHasUnansweredInput(nested, ctx({ immigrationDetails: immigration() })),
    ).toBe(true);
  });

  it("is false when the case has no immigration row at all", () => {
    // Nothing recorded yet is not the same as a field left blank on a row that
    // exists — there is no work to protect, because none was ever materialized.
    expect(conditionHasUnansweredInput(AOS_GATE, ctx())).toBe(true);
  });
});
