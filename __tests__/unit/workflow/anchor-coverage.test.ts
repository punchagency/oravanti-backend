import { describe, expect, it } from "@jest/globals";
import { UNBACKED_ANCHORS } from "../../../src/modules/workflow/due-date-resolver";
import { SYSTEM_TEMPLATES } from "../../../src/db/seeds/workflow-template.seed";
import type { DateAnchor } from "../../../src/db/schema/document-requirements";
import type { TemplateDef } from "../../../src/db/seeds/workflow-template.seed";

/**
 * Every anchor a seeded template uses must resolve to a real backing field.
 *
 * This is the test whose absence let a real gap sit unnoticed: `date_anchor`
 * declared six immigration anchors that no column backed, the AOS template
 * anchored sixteen of its thirty-six steps on them, and `resolveDueDate`
 * returned null for every one. Nothing failed — the steps simply rendered as
 * "due once recorded", and the entire second half of a matter had no deadlines.
 *
 * Type-checking cannot catch this: the anchor is a valid enum value and the
 * resolver returns a valid null. Only a test comparing the two lists can.
 */

/**
 * Gaps that exist today and are deliberately out of scope, pinned exactly.
 *
 * Asserting equality rather than "no new gaps" means this list can only shrink:
 * a new undated anchor fails the test, and fixing one of these fails it too
 * until the entry is removed. Both are the behaviour we want.
 *
 * `naturalization` — the N-400 oath-ceremony step. Backing it needs an
 * `oath_ceremony` milestone, which belongs with the N-400 phase, not this one.
 */
const KNOWN_UNDATED: Partial<Record<keyof typeof SYSTEM_TEMPLATES, DateAnchor[]>> = {
  naturalization: ["oath_ceremony_date"],
};

const anchorsUsedBy = (template: TemplateDef): DateAnchor[] =>
  template.modules.flatMap((m) =>
    m.steps.map((s) => s.dueDateAnchor).filter((a): a is DateAnchor => !!a),
  );

const templateKeys = Object.keys(SYSTEM_TEMPLATES) as (keyof typeof SYSTEM_TEMPLATES)[];

describe("every anchor a template uses has a backing field", () => {
  it.each(templateKeys)("%s", (key) => {
    const undated = [...new Set(anchorsUsedBy(SYSTEM_TEMPLATES[key]))]
      .filter((anchor) => UNBACKED_ANCHORS.has(anchor))
      .sort();

    // If this fails with a NEW anchor, add the backing column — do not add it
    // to UNBACKED_ANCHORS or to KNOWN_UNDATED to make it pass. That is exactly
    // how the original gap happened.
    expect(undated).toEqual((KNOWN_UNDATED[key] ?? []).slice().sort());
  });
});

describe("the AOS template is fully dated", () => {
  it("anchors no step on an unbacked field", () => {
    // Section 1 is the phase this work covers, so it gets its own assertion
    // rather than relying on an empty entry in KNOWN_UNDATED.
    const undated = anchorsUsedBy(SYSTEM_TEMPLATES.adjustmentOfStatus).filter((a) =>
      UNBACKED_ANCHORS.has(a),
    );
    expect(undated).toEqual([]);
  });

  it("resolves the six anchors that gained columns in 0017", () => {
    for (const anchor of [
      "receipt_date",
      "biometrics_appointment",
      "interview_scheduled_date",
      "decision_date",
      "card_valid_to",
      "green_card_expiration_date",
    ] as const) {
      expect(UNBACKED_ANCHORS.has(anchor)).toBe(false);
    }
  });
});
