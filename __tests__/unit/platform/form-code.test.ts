import { describe, expect, it } from "@jest/globals";

import {
  addFormBody,
  updateFormBody,
} from "../../../src/modules/platform/platform.validation";
import { formLocalPrefix } from "../../../src/modules/workflow/pdf-field-naming";

/*
  What a form code is allowed to be, and why the answer is not "what USCIS
  prints".

  The rule used to be `^[A-Z]{1,4}-\d{1,4}[A-Z]?$` — immigration's house style,
  written down as a law. Oravanti is not only an immigration product, and that
  pattern rejects real codes on real forms in tax, family law and state courts.
  It also rejected them silently at the wrong moment: an operator typing `1040`
  got "Expected a code like I-485", which is an answer to a question they were
  not asking.

  What the system genuinely needs is narrower and is not about shape at all,
  because the code is not a label — it is the join key. `form_code` is a `text`
  column in eight tables matched by value, it is a URL segment, it is part of
  an object key, and `formLocalPrefix` compacts it to name every field read off
  the blank. These tests pin each of those, and the collision the loosening
  makes reachable.
*/

const parse = (formCode: string) =>
  addFormBody.safeParse({ formCode, title: "A form" });

describe("a form code is not USCIS's house style", () => {
  it.each([
    ["I-485", "immigration"],
    ["I-130A", "immigration, with a suffix"],
    ["N-400", "immigration"],
    ["1040", "federal tax — no letters at all"],
    ["W-2", "federal tax"],
    ["SS-5", "Social Security"],
    ["FL-100", "California family law"],
    ["FL-341(E)", "California family law, with a parenthesised subsection"],
    ["AOC-CV-100", "North Carolina courts — two hyphens"],
    ["SAPCR", "Texas family law — letters only"],
    ["DS-11", "State Department"],
  ])("accepts %s (%s)", (formCode) => {
    expect(parse(formCode).success).toBe(true);
  });

  /*
    The three refusals are the three things the code has to be, and each breaks
    something specific rather than merely looking wrong: a slash splits the URL
    segment and the object key, a space has to be percent-encoded in both, and a
    code of pure punctuation compacts to an empty prefix — which would name
    every field on that form `.pt2.4a_family_name`.
  */
  it.each([
    ["I-485/A", "a slash breaks the URL segment and the object key"],
    ["FL 100", "a space has to be encoded in both"],
    ["-485", "must start with a letter or digit"],
    ["--", "compacts to an empty field-key prefix"],
    ["", "a form needs a code"],
    ["I-485-SUPPLEMENT-A-LONG-ONE", "over 24 characters"],
  ])("refuses %s (%s)", (formCode) => {
    expect(parse(formCode).success).toBe(false);
  });

  it("normalises to upper case, so i-485 and I-485 are one form", () => {
    const parsed = parse("i-485");
    expect(parsed.success && parsed.data.formCode).toBe("I-485");
  });

  it("says what is allowed rather than naming one example", () => {
    const parsed = parse("FL 100");
    // The old message was "Expected a code like I-485 or I-130A", which reads
    // as "your form is the wrong kind of form" to anybody outside immigration.
    const message = parsed.success ? "" : parsed.error.issues[0].message;
    expect(message).toMatch(/letters, digits/);
    expect(message).not.toMatch(/I-485/);
  });
});

describe("two codes that compact to one prefix are one namespace", () => {
  /*
    The collision the loosening makes reachable, and the reason
    `addCatalogueForm` checks the database rather than trusting the pattern.

    Every field read off a blank is named `<prefix>.pt2.4a_family_name`. Two
    catalogue entries sharing a prefix write into one namespace: importing the
    second renames the first's fields out from under every mapping made against
    them, and `clearGeneratedCatalogue` on either deletes both.

    Under the old pattern this was unreachable — a hyphen was required in a
    fixed place, so no two accepted codes could compact alike. Both of these
    pairs are accepted now.
  */
  it.each([
    ["FL-100", "FL100"],
    ["I-485", "i485"],
    ["FL-341(E)", "FL341E"],
  ])("%s and %s are the same prefix", (a, b) => {
    expect(parse(a).success).toBe(true);
    expect(parse(b).success).toBe(true);
    expect(formLocalPrefix(a)).toBe(formLocalPrefix(b));
  });

  it("still tells genuinely different codes apart", () => {
    expect(formLocalPrefix("FL-100")).not.toBe(formLocalPrefix("FL-101"));
    expect(formLocalPrefix("AOC-CV-100")).not.toBe(formLocalPrefix("AOC-CR-100"));
  });
});

describe("a form is classified by practice area, and by several", () => {
  /*
    What somebody naming a form actually knows: the kind of work it is for. They
    do not yet know which of the 150 matter types under Immigration will file
    it, and this must not guess — turning one area into 150 `case_type_forms`
    rows would put the form on every matter opened afterwards. That decision
    stays on the matter type's own page.
  */
  it("takes practice area ids", () => {
    const parsed = addFormBody.safeParse({
      formCode: "I-601",
      title: "Application for Waiver of Grounds of Inadmissibility",
      practiceAreaIds: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
    });
    expect(parsed.success).toBe(true);
  });

  it("takes more than one, because a form is filed under several", () => {
    // The I-864 is filed on a family-based adjustment and on an employment-based
    // one. A single owning area would be the lie this plurality exists to avoid.
    const parsed = addFormBody.safeParse({
      formCode: "I-864",
      title: "Affidavit of Support",
      practiceAreaIds: [
        "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("is optional, because a form may be catalogued before anybody decides", () => {
    expect(parse("I-601").success).toBe(true);
  });

  it("takes no case type, because naming a form is not building a package", () => {
    // `.strict()`, so this is a 400 rather than a field quietly ignored. What a
    // matter opens with is `case_type_forms` and is set on the matter type's
    // page; accepting it here would be a second door onto rows that have one.
    const parsed = addFormBody.safeParse({
      formCode: "I-601",
      title: "A form",
      caseTypeIds: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("a classification can be changed after the fact", () => {
  /*
    The filing package is not editable from a form's own page, on purpose — it
    belongs to the matter type. This is the opposite case: `form_practice_areas`
    has no other screen, so if the form's dialog could only ever add, a
    mis-click would be permanent.
  */
  it("takes the whole set on an edit", () => {
    const parsed = updateFormBody.safeParse({
      title: "Affidavit of Support",
      practiceAreaIds: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
    });
    expect(parsed.success).toBe(true);
  });

  it("tells 'clear them' apart from 'leave them alone'", () => {
    // Two different intentions, and the picker can express both: an empty array
    // says the form is for nothing in particular, absence says this edit was
    // about the title.
    expect(updateFormBody.safeParse({ practiceAreaIds: [] }).success).toBe(true);
    const untouched = updateFormBody.safeParse({ title: "A form" });
    expect(untouched.success && "practiceAreaIds" in untouched.data).toBe(false);
  });

  it("still takes no case type", () => {
    const parsed = updateFormBody.safeParse({
      caseTypeIds: ["3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
    });
    expect(parsed.success).toBe(false);
  });
});
