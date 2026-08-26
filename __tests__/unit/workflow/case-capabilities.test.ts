import { describe, expect, it } from "@jest/globals";
import { fieldsReferencedBy } from "../../../src/modules/workflow/case-capabilities.service";
import { SYSTEM_TEMPLATES } from "../../../src/db/seeds/workflow-template.seed";
import type { Condition, ConditionField } from "../../../src/db/schema/workflow";

/*
  Which case types run the adjustment package, asserted against the seed.

  This is what stops one case type's forms turning up on another's matter. The
  endpoints serving the I-485 pre-filing checks and the package fee quote took a
  case id and asked nothing else, so an N-400 got a quote for four forms it will
  never file and had the affidavit-of-support rules run against a sponsor it
  does not have.

  The answer comes from the template rather than a case-type name list, so these
  tests pin the derivation *and* the templates it reads. If someone regates the
  AOS package on a different field, the test that fails is the one saying an
  adjustment matter still qualifies — not a silent behaviour change months later.
*/

const ADJUSTMENT_TRIGGERS: ConditionField[] = [
  "immigrationDetails.filingTrack",
  "immigrationDetails.priorityDateIsCurrent",
];

/** The service's own rule, over a template definition rather than the database. */
const runsAdjustmentPackage = (template: { modules: { activationCondition?: Condition | null }[] }) => {
  const fields = new Set(template.modules.flatMap((m) => fieldsReferencedBy(m.activationCondition)));
  return ADJUSTMENT_TRIGGERS.some((f) => fields.has(f));
};

describe("flattening a condition to the fields it reads", () => {
  it("reads a plain leaf", () => {
    expect(fieldsReferencedBy({ field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" }))
      .toStrictEqual(["immigrationDetails.filingTrack"]);
  });

  it("reads through anyOf, which is how the AOS gate is written", () => {
    // The gate that matters most is a composite. Reading `.field` off the top
    // level returns undefined for it, which is the bug this replaces.
    const fields = fieldsReferencedBy({
      anyOf: [
        { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
        { field: "immigrationDetails.priorityDateIsCurrent", op: "eq", value: true },
      ],
    });

    expect(fields).toStrictEqual([
      "immigrationDetails.filingTrack",
      "immigrationDetails.priorityDateIsCurrent",
    ]);
  });

  it("reads through nested allOf/anyOf", () => {
    const fields = fieldsReferencedBy({
      allOf: [
        { field: "case.priority", op: "eq", value: "high" },
        {
          anyOf: [
            { field: "immigrationDetails.filingTrack", op: "eq", value: "concurrent" },
            { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true },
          ],
        },
      ],
    });

    expect(fields).toStrictEqual([
      "case.priority",
      "immigrationDetails.filingTrack",
      "immigrationDetails.isConditionalResidence",
    ]);
  });

  it("returns nothing for a module with no condition", () => {
    // Every N-400 module is unconditional, so this is the common case, not an
    // edge one. It must be an empty array and not `[undefined]`.
    expect(fieldsReferencedBy(null)).toStrictEqual([]);
    expect(fieldsReferencedBy(undefined)).toStrictEqual([]);
  });
});

describe("only the adjustment template runs the adjustment package", () => {
  it("qualifies the family-based AOS template", () => {
    expect(runsAdjustmentPackage(SYSTEM_TEMPLATES.adjustmentOfStatus)).toBe(true);
  });

  it("does not qualify naturalization", () => {
    // An N-400 has no petitioner, no sponsor and no I-693. Quoting it an I-130
    // fee is quoting a form the matter will never file.
    expect(runsAdjustmentPackage(SYSTEM_TEMPLATES.naturalization)).toBe(false);
  });

  it("does not qualify mandamus", () => {
    expect(runsAdjustmentPackage(SYSTEM_TEMPLATES.mandamus)).toBe(false);
  });

  it("does not qualify personal injury", () => {
    // It branches on a condition field, just not one of these — which is the
    // point of matching on the specific fields rather than on "has conditions".
    expect(runsAdjustmentPackage(SYSTEM_TEMPLATES.personalInjury)).toBe(false);
  });
});

describe("the trigger fields are the ones the template actually gates on", () => {
  it("gates the AOS package module on both of them", () => {
    // If this drifts, the endpoints start refusing real adjustment matters —
    // a silent failure that looks like missing data rather than a bug.
    const pkg = SYSTEM_TEMPLATES.adjustmentOfStatus.modules.find((m) =>
      m.name.startsWith("AOS Package Assembly"),
    );

    expect(pkg).toBeDefined();
    expect(fieldsReferencedBy(pkg!.activationCondition).sort()).toStrictEqual([
      "immigrationDetails.filingTrack",
      "immigrationDetails.priorityDateIsCurrent",
    ]);
  });
});
