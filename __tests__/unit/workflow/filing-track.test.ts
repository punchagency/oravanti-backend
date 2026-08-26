import { describe, expect, it } from "@jest/globals";
import {
  deriveFilingEligibility,
  type PetitionerStatus,
  type RelationshipCategory,
} from "../../../src/modules/workflow/filing-track";

/*
  § 1.1 of the source document, asserted cell by cell.

  This is a transcription of a statutory table, so the test is the transcription
  checked twice rather than a set of examples: all twelve combinations appear
  below, including the three the law does not permit. A missing row is the
  failure mode — a combination nobody thought about silently taking the
  `sequential` default and putting a case on a track it can never complete.
*/

type Row = [PetitionerStatus, RelationshipCategory, string, string];

/** petitioner, relationship, expected category, expected track. */
const TABLE: Row[] = [
  // A U.S. citizen's spouse, parent and minor child are immediate relatives:
  // not subject to the annual numerical limits, so a visa is always available
  // and the I-130 and I-485 are filed together.
  ["usc", "spouse", "ir", "concurrent"],
  ["usc", "parent", "ir", "concurrent"],
  ["usc", "child_under_21", "ir", "concurrent"],

  // Everyone else competes for a capped number of visas and waits for a
  // priority date, which is exactly what the sequential track models.
  ["usc", "unmarried_child_over_21", "f1", "sequential"],
  ["usc", "married_child", "f3", "sequential"],
  ["usc", "sibling", "f4", "sequential"],

  // An LPR has no immediate-relative category at all — even a spouse is F2A.
  ["lpr", "spouse", "f2a", "sequential"],
  ["lpr", "child_under_21", "f2a", "sequential"],
  ["lpr", "unmarried_child_over_21", "f2b", "sequential"],
];

describe("deriveFilingEligibility", () => {
  it.each(TABLE)("%s petitioning a %s → %s, %s", (status, relationship, category, track) => {
    const result = deriveFilingEligibility(status, relationship);

    expect(result).toEqual({
      petitionable: true,
      preferenceCategory: category,
      filingTrack: track,
    });
  });

  /*
    The three combinations with no category.

    An LPR cannot petition a parent, a sibling, or a married son or daughter —
    there is no visa category for any of them. Returning a plausible-looking
    category here would be worse than returning nothing: the case would go on the
    sequential track and wait for a priority date that will never come current,
    and nothing downstream would ever say why.
  */
  it.each([
    ["parent" as const, "parent"],
    ["married_child" as const, "married son or daughter"],
    ["sibling" as const, "sibling"],
  ])("an LPR cannot petition a %s", (relationship, phrase) => {
    const result = deriveFilingEligibility("lpr", relationship);

    expect(result.petitionable).toBe(false);
    if (result.petitionable) throw new Error("unreachable");

    // The reason is shown to a user, so it has to name the relationship and say
    // who *can* file — not just report a failure.
    expect(result.reason).toContain(phrase);
    expect(result.reason).toContain("U.S. citizen");
  });

  it("covers every combination of the two enums", () => {
    // The guard on the table above: if a value is added to either enum, this
    // fails until the new row is transcribed and asserted, rather than the new
    // combination quietly falling through to a default.
    const statuses: PetitionerStatus[] = ["usc", "lpr"];
    const relationships: RelationshipCategory[] = [
      "spouse",
      "parent",
      "child_under_21",
      "unmarried_child_over_21",
      "married_child",
      "sibling",
    ];

    const asserted = new Set([
      ...TABLE.map(([s, r]) => `${s}/${r}`),
      "lpr/parent",
      "lpr/married_child",
      "lpr/sibling",
    ]);

    const all = statuses.flatMap((s) => relationships.map((r) => `${s}/${r}`));

    expect(all.filter((combo) => !asserted.has(combo))).toEqual([]);
    expect(asserted.size).toBe(all.length);
  });

  it("never returns a category without a track, or a track without a category", () => {
    // Both come off the same table, so they can only disagree if someone splits
    // the function later. This is the assertion that would catch that.
    for (const [status, relationship] of TABLE) {
      const result = deriveFilingEligibility(status, relationship);
      if (!result.petitionable) throw new Error("unreachable");

      expect(Boolean(result.preferenceCategory)).toBe(Boolean(result.filingTrack));
      // IR is the no-numerical-limit category, so it is the only concurrent one.
      expect(result.filingTrack === "concurrent").toBe(result.preferenceCategory === "ir");
    }
  });
});
