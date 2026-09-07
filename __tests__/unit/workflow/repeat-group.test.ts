import {
  asRepeatGroupConfig,
  FIELD_KEY,
  parseIndexedKey,
  valueAtIndexedKey,
} from "../../../src/modules/workflow/repeat-group";

/**
 * The grammar a form box uses to name one entry of a repeating answer.
 *
 * Every failure here is silent in production — a box that fills with nothing,
 * or worse, with the wrong entry's value — so the cases below are the ones that
 * would not announce themselves.
 */
describe("indexed field keys", () => {
  it("reads the entry and the sub-field out of a key", () => {
    expect(parseIndexedKey("beneficiary.address_history[2].city")).toEqual({
      base: "beneficiary.address_history",
      index: 2,
      leaf: "city",
    });
  });

  it("keeps a dotted base whole", () => {
    // The base is the question's key and question keys are dotted by design.
    // A non-greedy match would call this entry 1 of `beneficiary`.
    expect(parseIndexedKey("a.b.c[1].street")?.base).toBe("a.b.c");
  });

  it("is not fooled by an ordinary key", () => {
    expect(parseIndexedKey("beneficiary.family_name")).toBeNull();
    expect(parseIndexedKey("beneficiary.address_history")).toBeNull();
  });

  it("refuses index 0 rather than treating it as the first entry", () => {
    // Written by somebody who assumed an array subscript. Filling entry 1 from
    // it would be a wrong answer that looks right on the paper.
    expect(parseIndexedKey("beneficiary.address_history[0].city")).toBeNull();
  });
});

describe("reading one entry", () => {
  const answer = [
    { street: "123 Main St", city: "Brooklyn", state: "NY" },
    { street: "9 Elm Rd", city: "Newark", state: "NJ", zip: "" },
  ];
  const key = (raw: string) => parseIndexedKey(raw)!;

  it("counts entries from one", () => {
    expect(
      valueAtIndexedKey(answer, key("beneficiary.address_history[1].city")),
    ).toBe("Brooklyn");
    expect(
      valueAtIndexedKey(answer, key("beneficiary.address_history[2].city")),
    ).toBe("Newark");
  });

  it("gives nothing for an entry the client does not have", () => {
    /*
      The load-bearing case. A client who has lived at one address must not get
      entry 2's boxes stamped with blanks — an empty block on a USCIS form means
      "not applicable", and a filled-with-nothing one means the same thing while
      counting as answered everywhere in this app.
    */
    expect(
      valueAtIndexedKey(answer, key("beneficiary.address_history[3].city")),
    ).toBeUndefined();
  });

  it("gives nothing for a sub-field that is absent or blank", () => {
    expect(
      valueAtIndexedKey(answer, key("beneficiary.address_history[1].zip")),
    ).toBeUndefined();
    expect(
      valueAtIndexedKey(answer, key("beneficiary.address_history[2].zip")),
    ).toBeUndefined();
  });

  it("gives nothing when the answer is not a list of entries", () => {
    // A question whose type was changed under a stored answer, or a firm's own
    // question that happens to share the key. Neither may throw mid-pass and
    // abandon the other forty fields.
    for (const wrong of ["Brooklyn", 42, null, { city: "Brooklyn" }, ["a"]]) {
      expect(
        valueAtIndexedKey(wrong, key("beneficiary.address_history[1].city")),
      ).toBeUndefined();
    }
  });
});

describe("reading a group's config", () => {
  it("accepts a declared group", () => {
    const config = asRepeatGroupConfig({
      itemLabel: "Address",
      fields: [{ key: "street", label: "Street", type: "short_text" }],
    });
    expect(config?.itemLabel).toBe("Address");
    expect(config?.fields).toHaveLength(1);
  });

  it("names an entry even when the group did not", () => {
    const config = asRepeatGroupConfig({
      fields: [{ key: "street", label: "Street", type: "short_text" }],
    });
    expect(config?.itemLabel).toBe("Entry");
  });

  it("refuses anything that is not one, rather than throwing", () => {
    // `config` is jsonb with no schema behind it and this is read on the
    // population path, where a malformed row must cost one field and not a run.
    for (const wrong of [
      null,
      undefined,
      "fields",
      { options: ["a", "b"] },
      { fields: [] },
      { fields: [{ label: "no key" }] },
    ]) {
      expect(asRepeatGroupConfig(wrong)).toBeNull();
    }
  });
});

/**
 * What the endpoints will accept as a field key.
 *
 * The shape and the grammar have to admit the same keys, and when they did not
 * the failure landed nowhere near either: `FIELD_KEY` was
 * `^[a-z0-9_]+(\.[a-z0-9_]+)*$` in two validation files, which refuses every
 * key naming one entry of a repeating answer — 80 of them on the I-485, 14 on
 * the I-864, 9 on the I-130. Saving one field at a time worked as long as
 * nobody touched a repeating one; saving a whole form sends every changed field
 * in a single batch, so one repeating field 400'd the lot and the message named
 * a "field key" rather than the form somebody had just spent an hour filling.
 *
 * So the two are asserted against each other: anything the parser reads as an
 * indexed key must pass the shape.
 */
describe("the field key shape the endpoints validate", () => {
  it("admits an ordinary key", () => {
    expect(FIELD_KEY.test("beneficiary.date_of_birth")).toBe(true);
    expect(FIELD_KEY.test("i485.pt9.3a_membership")).toBe(true);
  });

  it("admits a key naming one entry of a repeating answer", () => {
    for (const key of [
      "beneficiary.address_history[1].street",
      "petitioner.address_history[2].zip",
      "marriage.prior_spouses[1].middle_name",
      "sponsor.tax_returns[3].total_income",
    ]) {
      expect(FIELD_KEY.test(key)).toBe(true);
      // And the grammar agrees it is one, which is the pairing that broke.
      expect(parseIndexedKey(key)).not.toBeNull();
    }
  });

  it("still refuses what a malformed key looks like", () => {
    for (const key of [
      "",
      "Beneficiary.date_of_birth",
      "beneficiary..city",
      "beneficiary.address_history[]",
      "beneficiary.address_history[1]",
      "beneficiary.address_history[1].",
      "drop table; --",
    ]) {
      expect(FIELD_KEY.test(key)).toBe(false);
    }
  });
});
