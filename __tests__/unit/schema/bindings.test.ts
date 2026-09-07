import { describe, expect, it, jest } from "@jest/globals";

jest.mock("../../../src/db/client", () => ({ db: {} }));

import { resolveBindings } from "../../../src/db/seeds/schema-nodes.seed";
import { pathOf } from "../../../src/modules/workflow/repeat-group";

/**
 * A slice of the real vocabulary: one plain datum, one repeating leaf, and the
 * list that leaf belongs to.
 */
const NODES = new Map([
  ["beneficiary.date_of_birth", { id: "n-dob", isRepeating: false, dataType: "date" }],
  [
    "beneficiary.address_history",
    { id: "n-list", isRepeating: true, dataType: "repeat_group" },
  ],
  [
    "beneficiary.address_history[].city",
    { id: "n-city", isRepeating: true, dataType: "short_text" },
  ],
]);

const isFormLocal = (key: string) => key.startsWith("i485.") || key.startsWith("i130.");

const row = (
  fieldKey: string | null,
  stored: { schemaNodeId: string | null; entryIndex: number | null } = {
    schemaNodeId: null,
    entryIndex: null,
  },
) => ({
  id: `row-${fieldKey ?? "null"}`,
  fieldKey,
  ...stored,
});

const forms = (keys: (string | null)[]) =>
  resolveBindings(keys.map((k) => row(k)), NODES, isFormLocal, { allowEntryIndex: true });

const questions = (keys: (string | null)[]) =>
  resolveBindings(keys.map((k) => row(k)), NODES, isFormLocal, { allowEntryIndex: false });

describe("pathOf collapses an entry to its node", () => {
  it("keeps a plain key as it is", () => {
    expect(pathOf("beneficiary.date_of_birth")).toEqual({
      path: "beneficiary.date_of_birth",
      entryIndex: null,
    });
  });

  it("splits an indexed key into the node and the entry", () => {
    expect(pathOf("beneficiary.address_history[2].city")).toEqual({
      path: "beneficiary.address_history[].city",
      entryIndex: 2,
    });
  });

  /*
    `[0]` is what somebody writes who assumed an array subscript.
    `parseIndexedKey` refuses it rather than reading it as entry 1, so the key
    stays whole here and resolves to nothing — which is the loud outcome. Filling
    the current address from it would be a wrong answer that looks right on paper.
  */
  it("does not read [0] as the first entry", () => {
    expect(pathOf("beneficiary.address_history[0].city").entryIndex).toBeNull();
    expect(forms(["beneficiary.address_history[0].city"]).unresolved).toEqual([
      "beneficiary.address_history[0].city",
    ]);
  });
});

describe("resolving a form field's binding", () => {
  it("binds a plain datum with no entry index", () => {
    const r = forms(["beneficiary.date_of_birth"]);
    expect([r.bound, r.unresolved, r.misuse]).toEqual([1, [], []]);
    expect([...r.wanted.keys()]).toEqual(["n-dob|"]);
  });

  it("binds an entry of a repeating datum, keeping which entry", () => {
    const r = forms([
      "beneficiary.address_history[1].city",
      "beneficiary.address_history[2].city",
    ]);
    expect(r.bound).toBe(2);
    expect([...r.wanted.keys()].sort()).toEqual(["n-city|1", "n-city|2"]);
  });

  /*
    86% of the catalogue. Extraction names every box it finds and most are asked
    by one form only — a legitimate null binding, and it must not be reported as
    a problem or the report is 1,530 lines of noise nobody reads.
  */
  it("counts a form's own box name without listing it", () => {
    const r = forms(["i130.pt2.2_uscis_online_account_number", "i485.pt9.10_yes_no"]);
    expect([r.formLocal, r.bound, r.unresolved]).toEqual([2, 0, []]);
  });

  /*
    The whole point of the exercise. A well-formed key naming no node is
    indistinguishable from one naming a real datum — it fills nothing and
    reports nothing — so this list is the first thing that can find a typo
    before a filing does.
  */
  it("names a shared-looking key that resolves to nothing", () => {
    const r = forms(["beneficiary.date_of_brith", "benficiary.date_of_birth"]);
    expect(r.unresolved).toEqual(["beneficiary.date_of_brith", "benficiary.date_of_birth"]);
    expect(r.bound).toBe(0);
  });

  it("refuses to bind a box to a whole list", () => {
    const r = forms(["beneficiary.address_history"]);
    expect(r.bound).toBe(0);
    expect(r.misuse).toEqual(["beneficiary.address_history (a box cannot print a whole list)"]);
  });

  it("clears a binding whose key no longer resolves", () => {
    const r = resolveBindings(
      [row("beneficiary.gone", { schemaNodeId: "n-dob", entryIndex: null })],
      NODES,
      isFormLocal,
      { allowEntryIndex: true },
    );
    expect(r.cleared).toBe(1);
    expect([...r.wanted.keys()]).toEqual(["|"]);
  });

  /*
    Re-run safety. The catalogue seed adds fields whenever a form is
    re-extracted, so this runs again and again over rows that are already right.
  */
  it("writes nothing for a row that is already bound correctly", () => {
    const r = resolveBindings(
      [row("beneficiary.address_history[2].city", { schemaNodeId: "n-city", entryIndex: 2 })],
      NODES,
      isFormLocal,
      { allowEntryIndex: true },
    );
    expect([r.bound, r.wanted.size]).toEqual([1, 0]);
  });

  it("ignores a row with no field key at all", () => {
    const r = forms([null]);
    expect([r.bound, r.formLocal, r.unresolved, r.wanted.size]).toEqual([0, 0, [], 0]);
  });
});

describe("resolving a question's binding", () => {
  it("binds a question to the list itself", () => {
    const r = questions(["beneficiary.address_history"]);
    expect(r.bound).toBe(1);
    expect([...r.wanted.keys()]).toEqual(["n-list|"]);
  });

  /*
    A question asks a whole list at once. One keyed at an entry would ask "where
    did you live before?" as something answerable exactly once, which is the
    shape `repeat_group` exists to replace.
  */
  it("refuses a question keyed at one entry", () => {
    const r = questions(["beneficiary.address_history[2].city"]);
    expect(r.bound).toBe(0);
    expect(r.misuse).toEqual([
      "beneficiary.address_history[2].city (a question may not name one entry)",
    ]);
  });
});
