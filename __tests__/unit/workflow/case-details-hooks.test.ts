import { describe, expect, it } from "@jest/globals";
import { dateAnchorEnum } from "../../../src/db/schema/document-requirements";
import { immigrationCaseDetails } from "../../../src/db/schema/immigration-case-details";
import { personalInjuryCaseDetails } from "../../../src/db/schema/personal-injury-case-details";
import {
  applyDerivedFilingTrack,
  WRITE_HOOK_FIELDS,
} from "../../../src/modules/workflow/case-details.service";
import { CONDITION_FIELDS } from "../../../src/modules/workflow/workflow-template.validation";

/*
  Writing one of the two practice-area extension tables runs three hooks, each
  keyed on a hand-maintained list of column names (case-details.service.ts).

  A column that *should* be on one of those lists but isn't produces the worst
  kind of bug: the write succeeds, the response looks right, and nothing
  re-runs. No type error, no failing request — a module that silently never
  activates, or a task whose due date silently never moves. These tests are the
  only thing standing between that and production.
*/

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const columnNames = (table: Record<string, unknown>) =>
  new Set(Object.keys(table));

describe("condition-field hook lists", () => {
  /**
   * The one fully bidirectional check here: `CONDITION_FIELDS` is the closed
   * union a template's `activationCondition` may reference, so the set of
   * fields whose write must re-run materialization is exactly its
   * extension-table half. Adding a condition field without adding it here means
   * a firm can author a module that never activates.
   */
  it("covers exactly the extension-table half of CONDITION_FIELDS", () => {
    const expected = (prefix: string) =>
      CONDITION_FIELDS.filter((f) => f.startsWith(`${prefix}.`))
        .map((f) => f.slice(prefix.length + 1))
        .sort();

    expect([...WRITE_HOOK_FIELDS.immigration.condition].sort()).toEqual(
      expected("immigrationDetails"),
    );
    expect([...WRITE_HOOK_FIELDS.personalInjury.condition].sort()).toEqual(
      expected("personalInjuryDetails"),
    );
  });

  it("accounts for every CONDITION_FIELDS entry", () => {
    // `case.priority` lives on `cases`, not on either extension table — it is
    // the one condition field no extension-table write can change, and this
    // asserts that's the *only* one, so a third context object added to
    // ConditionContext without a hook list fails here.
    const covered = [
      ...WRITE_HOOK_FIELDS.immigration.condition.map((f) => `immigrationDetails.${f}`),
      ...WRITE_HOOK_FIELDS.personalInjury.condition.map((f) => `personalInjuryDetails.${f}`),
    ];
    const uncovered = CONDITION_FIELDS.filter((f) => !covered.includes(f));

    expect(uncovered).toEqual(["case.priority"]);
  });
});

describe("anchor-field hook lists", () => {
  const anchors = new Set<string>(dateAnchorEnum.enumValues);

  it.each([
    ["immigration", WRITE_HOOK_FIELDS.immigration.anchor, immigrationCaseDetails],
    ["personalInjury", WRITE_HOOK_FIELDS.personalInjury.anchor, personalInjuryCaseDetails],
  ])("%s anchor fields are real columns", (_name, fields, table) => {
    const columns = columnNames(table as unknown as Record<string, unknown>);
    for (const field of fields) expect(columns.has(field)).toBe(true);
  });

  it.each([
    ["immigration", WRITE_HOOK_FIELDS.immigration.anchor],
    ["personalInjury", WRITE_HOOK_FIELDS.personalInjury.anchor],
  ])("%s anchor fields name a real date_anchor value", (_name, fields) => {
    // A step can only anchor to a `date_anchor` enum value, so a field listed
    // here that doesn't correspond to one is a field no step can ever depend
    // on — dead weight that re-resolves due dates for nothing.
    for (const field of fields) expect(anchors.has(snake(field))).toBe(true);
  });

  it("does not list a field twice as both condition and anchor", () => {
    // Not illegal, but it would mean one write both re-materializes and
    // re-resolves — worth being deliberate about rather than accidental.
    for (const { condition, anchor } of Object.values(WRITE_HOOK_FIELDS)) {
      const overlap = condition.filter((f) => (anchor as readonly string[]).includes(f));
      expect(overlap).toEqual([]);
    }
  });
});

/*
  `filingTrack` and `preferenceCategory` are computed from the § 1.1 inputs, but
  a person can take them over. The rules for when the computer writes and when it
  keeps its hands off are the whole of this feature's risk: write too eagerly and
  an attorney's deliberate override is silently reverted; write too rarely and a
  case sits on a track its own data contradicts.
*/
describe("derived filing track", () => {
  const existing = (o: Partial<Record<string, unknown>> = {}) =>
    ({
      filingTrack: null,
      preferenceCategory: null,
      petitionerStatus: null,
      relationshipCategory: null,
      filingTrackIsManual: false,
      ...o,
    }) as Parameters<typeof applyDerivedFilingTrack>[1];

  it("derives both fields once both inputs are known", () => {
    const out = applyDerivedFilingTrack(
      { petitionerStatus: "usc", relationshipCategory: "spouse" },
      existing(),
    );

    expect(out.filingTrack).toBe("concurrent");
    expect(out.preferenceCategory).toBe("ir");
  });

  it("derives from one new input plus one already stored", () => {
    // The normal intake shape: the two facts are entered on different visits.
    const out = applyDerivedFilingTrack(
      { relationshipCategory: "sibling" },
      existing({ petitionerStatus: "usc" }),
    );

    expect(out.filingTrack).toBe("sequential");
    expect(out.preferenceCategory).toBe("f4");
  });

  it("leaves both alone while either input is unknown", () => {
    // Half a pair has no answer in the table. Guessing is how a case ends up on
    // a track nobody chose.
    const out = applyDerivedFilingTrack({ petitionerStatus: "usc" }, existing());

    expect(out.filingTrack).toBeUndefined();
    expect(out.preferenceCategory).toBeUndefined();
  });

  it("stops writing once the override latch is on", () => {
    const out = applyDerivedFilingTrack(
      { relationshipCategory: "spouse" },
      existing({ petitionerStatus: "usc", filingTrackIsManual: true, filingTrack: "sequential" }),
    );

    expect(out.filingTrack).toBeUndefined();
  });

  it("respects a latch being turned on in the same patch", () => {
    // Setting the track and the latch together is exactly what an override is.
    // Deriving here would overwrite the value in the very request that set it.
    const out = applyDerivedFilingTrack(
      { filingTrack: "sequential", filingTrackIsManual: true },
      existing({ petitionerStatus: "usc", relationshipCategory: "spouse" }),
    );

    expect(out.filingTrack).toBe("sequential");
  });

  it("hands the field back when the latch is cleared", () => {
    const out = applyDerivedFilingTrack(
      { filingTrackIsManual: false },
      existing({
        petitionerStatus: "usc",
        relationshipCategory: "spouse",
        filingTrackIsManual: true,
        filingTrack: "sequential",
      }),
    );

    expect(out.filingTrack).toBe("concurrent");
    expect(out.preferenceCategory).toBe("ir");
  });

  it("lets an explicit filingTrack win when the inputs are untouched", () => {
    const out = applyDerivedFilingTrack(
      { filingTrack: "sequential" },
      existing({ petitionerStatus: "usc", relationshipCategory: "spouse" }),
    );

    expect(out.filingTrack).toBe("sequential");
  });

  it("recomputes when the inputs change, even if the patch also names the track", () => {
    // Changing the underlying facts is a statement about the case; a stale
    // track sent alongside them is not.
    const out = applyDerivedFilingTrack(
      { filingTrack: "sequential", relationshipCategory: "spouse" },
      existing({ petitionerStatus: "usc" }),
    );

    expect(out.filingTrack).toBe("concurrent");
  });

  it("writes nothing for a combination the law does not permit", () => {
    // An LPR cannot petition a sibling. There is no correct track for a petition
    // that cannot be filed, so the fields stay empty and D8 explains why.
    const out = applyDerivedFilingTrack(
      { relationshipCategory: "sibling" },
      existing({ petitionerStatus: "lpr" }),
    );

    expect(out.filingTrack).toBeUndefined();
    expect(out.preferenceCategory).toBeUndefined();
  });
});
