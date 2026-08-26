import { describe, expect, it } from "@jest/globals";
import {
  CONDITION_FIELDS,
  conditionSchema,
  updateModuleBody,
} from "../../../src/modules/workflow/workflow-template.validation";

describe("conditionSchema", () => {
  it("accepts the conditions the seeded templates actually use", () => {
    const seeded = [
      { field: "personalInjuryDetails.defendantType", op: "eq", value: "government_entity" },
      { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
      { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true },
    ];
    for (const c of seeded) expect(conditionSchema.safeParse(c).success).toBe(true);
  });

  it("accepts every field in the union", () => {
    for (const field of CONDITION_FIELDS) {
      expect(conditionSchema.safeParse({ field, op: "eq", value: "x" }).success).toBe(true);
    }
  });

  it("accepts in / neq and nested allOf / anyOf", () => {
    expect(conditionSchema.safeParse({ field: "case.priority", op: "in", value: ["high"] }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: "case.priority", op: "neq", value: "low" }).success).toBe(true);
    expect(
      conditionSchema.safeParse({
        allOf: [
          { field: "case.priority", op: "eq", value: "high" },
          { anyOf: [{ field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" }] },
        ],
      }).success,
    ).toBe(true);
  });

  // The point of validating at save time: a field outside the union evaluates
  // false forever, and a module that silently never activates is close to
  // undebuggable from the outside — the tasks simply never appear.
  it("rejects a field outside the union", () => {
    expect(conditionSchema.safeParse({ field: "case.somethingMadeUp", op: "eq", value: "x" }).success).toBe(false);
  });

  it("rejects an unknown field nested inside a group", () => {
    expect(
      conditionSchema.safeParse({
        allOf: [
          { field: "case.priority", op: "eq", value: "high" },
          { field: "immigrationDetails.notARealField", op: "eq", value: "x" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown operator", () => {
    expect(conditionSchema.safeParse({ field: "case.priority", op: "gt", value: "high" }).success).toBe(false);
  });

  it("rejects a non-array value for `in`", () => {
    expect(conditionSchema.safeParse({ field: "case.priority", op: "in", value: "high" }).success).toBe(false);
  });

  it("rejects an empty group, which would otherwise be vacuously true", () => {
    expect(conditionSchema.safeParse({ allOf: [] }).success).toBe(false);
  });
});

describe("updateModuleBody", () => {
  it("accepts a partial edit", () => {
    expect(updateModuleBody.safeParse({ phase: "Investigation" }).success).toBe(true);
  });

  it("rejects an empty patch", () => {
    expect(updateModuleBody.safeParse({}).success).toBe(false);
  });

  it("rejects making a module conditional while clearing its condition", () => {
    expect(
      updateModuleBody.safeParse({ activationType: "conditional", activationCondition: null }).success,
    ).toBe(false);
  });

  it("allows clearing the condition when the module is no longer conditional", () => {
    expect(
      updateModuleBody.safeParse({ activationType: "manual", activationCondition: null }).success,
    ).toBe(true);
  });
});
