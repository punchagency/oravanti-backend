import {
  canonicalAnswer,
  fieldKeyFor,
  humanLabel,
  inferType,
  parseBoxName,
  parseTooltip,
  sameAnswer,
} from "../../../src/modules/workflow/pdf-field-naming";

/**
 * The grammar this reads is USCIS's, not ours, and it is not quite regular.
 * Every name below is a real one, copied out of the I-130 or I-485 blank —
 * including the ones that are wrong on the form itself. A mistake here is not a
 * crash: it is a catalogue that quietly describes the wrong item number, which
 * nobody would notice until a filing came back.
 */

const box = (leaf: string) => `form1[0].#subform[3].${leaf}[0]`;

describe("parsing a box name", () => {
  it("reads part, item and subject off the usual shape", () => {
    expect(parseBoxName(box("Pt2Line4a_FamilyName"))).toEqual({
      part: 2,
      line: "4a",
      tail: "FamilyName",
    });
  });

  it("accepts the three spellings of the part prefix", () => {
    // All on real blanks, sometimes on the same form.
    expect(parseBoxName(box("Pt1Line3_DOB"))?.part).toBe(1);
    expect(parseBoxName(box("P4Line5a_FamilyName"))?.part).toBe(4);
    expect(parseBoxName(box("Part1_Item18_InCareOfName"))?.part).toBe(1);
  });

  it("keeps a part-wide box that has no item number", () => {
    expect(parseBoxName(box("Pt7_NameofLanguage"))).toEqual({
      part: 7,
      line: null,
      tail: "NameofLanguage",
    });
  });

  it("corrects USCIS's own naming slips rather than mis-parsing them", () => {
    // The I-130 ships this box with no part number at all. Item 20.a. is Part 2.
    expect(parseBoxName(box("PtLine20a_FamilyName"))).toEqual({
      part: 2,
      line: "20a",
      tail: "FamilyName",
    });
    // The I-485 ships this one with the underscore missing.
    expect(parseBoxName(box("Pt1Line18PriorDateTo"))).toEqual({
      part: 1,
      line: "18",
      tail: "PriorDateTo",
    });
  });

  it("rejects the boxes that carry no question", () => {
    for (const leaf of [
      "TextField3",
      "CheckBox1",
      "a_YesNo",
      "AttorneyStateBarNumber",
      "VolagNumber",
    ]) {
      expect(parseBoxName(box(leaf))).toBeNull();
    }
  });
});

describe("turning a name into a label", () => {
  it("splits camel case and prints the item the way the form does", () => {
    expect(humanLabel("4a", "FamilyName")).toBe("4.a. Family Name");
    expect(humanLabel("18", "StreetNumberName")).toBe("18. Street Number Name");
  });

  it("breaks on joining words USCIS did not capitalise", () => {
    // `CountryofBirth` is one camel-case word; "Countryof Birth" is what a
    // naive split produces, and it looks like a typo on screen.
    expect(humanLabel("7", "CountryofBirth")).toBe("7. Country of Birth");
    expect(humanLabel("8", "DateofBirth")).toBe("8. Date of Birth");
    expect(humanLabel(null, "NameofLanguage")).toBe("Name of Language");
  });

  it("leaves a word alone when the joiner is only part of it", () => {
    expect(humanLabel(null, "CountryofCitizenshipNationality")).toBe(
      "Country of Citizenship Nationality",
    );
    expect(humanLabel(null, "AdditionalInfo")).toBe("Additional Information");
  });

  it("expands the abbreviations and keeps the acronyms whole", () => {
    expect(humanLabel("3", "DOB")).toBe("3. Date of Birth");
    expect(humanLabel("19", "SSN")).toBe("19. Social Security Number");
    expect(humanLabel("10", "PassportNum")).toBe("10. Passport Number");
    expect(humanLabel("9", "USCISAccountNumber")).toBe(
      "9. USCIS Account Number",
    );
  });

  it("does not read a standalone No as an abbreviation for Number", () => {
    // It did once, and every unnamed tick box came out as "Yes or Number".
    expect(humanLabel("3", "Yes or No")).toBe("3. Yes or No");
  });

  it("drops the shorthand that names the control rather than the question", () => {
    expect(humanLabel("6", "CB_Sex")).toBe("6. Sex");
    expect(humanLabel("3", "YN")).toBe("3.");
  });
});

describe("choosing a control for a box", () => {
  it("reads a date out of the expanded label, not the raw name", () => {
    // `OtherDOB` contains no word "date" until the abbreviation is expanded.
    expect(inferType("text", humanLabel("3a", "OtherDOB"))).toBe("date");
    expect(inferType("text", humanLabel("58a", "DateFrom"))).toBe("date");
  });

  it("does not turn a name that merely contains those letters into a date", () => {
    expect(inferType("text", humanLabel("21b", "ArrivalDeparture"))).toBe(
      "short_text",
    );
  });

  it("recognises the contact types", () => {
    expect(inferType("text", humanLabel("14", "DaytimePhoneNumber"))).toBe(
      "phone",
    );
    expect(inferType("text", humanLabel("16", "EmailAddress"))).toBe("email");
    expect(inferType("text", humanLabel("5d", "AdditionalInfo"))).toBe(
      "long_text",
    );
  });

  it("treats two named boxes under one item as a choice, one as a tick", () => {
    // Sex is Male/Female — a choice, not a checkbox somebody ticks for "yes".
    expect(inferType("checkbox", "9. Male / Female", 2)).toBe("single_choice");
    expect(inferType("checkbox", "3. Yes or No", 0)).toBe("yes_no");
  });

  it("passes a dropdown straight through, options and all", () => {
    expect(inferType("dropdown", "10. State")).toBe("dropdown");
  });
});

describe("the generated field key", () => {
  it("names where the box is and claims nothing more", () => {
    expect(
      fieldKeyFor("I-485", { part: 1, line: "1", tail: "FamilyName" }),
    ).toBe("i485.pt1.1_family_name");
    expect(
      fieldKeyFor("I-130", { part: 2, line: "4a", tail: "FamilyName" }),
    ).toBe("i130.pt2.4a_family_name");
  });

  it("is stable, so re-extracting the same edition updates rather than churns", () => {
    const parsed = parseBoxName(box("Pt2Line8_DateofBirth"))!;
    expect(fieldKeyFor("I-130", parsed)).toBe(fieldKeyFor("I-130", parsed));
    expect(fieldKeyFor("I-130", parsed)).toBe("i130.pt2.8_dateof_birth");
  });
});

/**
 * The tooltip is where a field's wording comes from, so every string below is
 * a verbatim `/TU` from the I-130 or I-485. The requirement is that a label
 * reads exactly as the form does — so the risk here is not a crash, it is a
 * statutory question quietly paraphrased into something the paper never said.
 */
describe("reading a box's printed question out of its tooltip", () => {
  it("separates the part heading from the question", () => {
    expect(
      parseTooltip(
        "Part 9. General Eligibility and Inadmissibility Grounds. 13. Have you EVER violated the terms or conditions of your nonimmigrant status? Select No.",
      ),
    ).toEqual({
      part: 9,
      title: "General Eligibility and Inadmissibility Grounds",
      question:
        "13. Have you EVER violated the terms or conditions of your nonimmigrant status?",
      selects: "No",
    });
  });

  it("trusts the printed part number over the box's own", () => {
    // This tooltip belongs to a box named `Pt8Line13_YesNo`. The form prints it
    // in Part 9, and the form is what a paralegal is holding.
    expect(
      parseTooltip("Part 9. General Eligibility and Inadmissibility Grounds. 13. Have you EVER?")
        .part,
    ).toBe(9);
  });

  it("closes a heading USCIS truncated mid-bracket", () => {
    expect(
      parseTooltip(
        "Part 1.  Information About You (Person applying for lawful permanent residence} 1. Your Current Legal Name (Do not provide a nickname). Enter Family Name, Last Name.",
      ),
    ).toMatchObject({
      part: 1,
      title: "Information About You (Person applying for lawful permanent residence)",
      question:
        "1. Your Current Legal Name (Do not provide a nickname). Enter Family Name, Last Name.",
    });
  });

  it("keeps the question whole rather than shortening it", () => {
    const { question } = parseTooltip(
      "Part 2. Application Type or Filing Category. 3.g. Additional Options. If you selected Diversity Visa program, provide your Diversity Visa Rank Number.",
    );
    expect(question).toBe(
      "3.g. Additional Options. If you selected Diversity Visa program, provide your Diversity Visa Rank Number.",
    );
  });

  it("takes the option name off, wherever in the tooltip it sits", () => {
    // The "Yes" half carries guidance the "No" half does not. Left in place it
    // gives one question two texts, and the question gets catalogued twice.
    const yes = parseTooltip(
      'Part 9. General Eligibility and Inadmissibility Grounds. 1. Have you EVER been a member of any organization? Select Yes. If you answered "Yes" to Item Number 1., complete Item Numbers 2. - 9.',
    );
    const no = parseTooltip(
      "Part 9. General Eligibility and Inadmissibility Grounds. 1. Have you EVER been a member of any organization? Select No.",
    );

    expect(yes.selects).toBe("Yes");
    expect(no.selects).toBe("No");
    expect(yes.question).toBe(no.question);
  });

  it("keeps an option that runs to a full clause", () => {
    expect(
      parseTooltip(
        "Part 1. Relationship. 2. If you are filing this petition for your child or parent, select the box that describes your relationship (Select only one box). Select Child was born to parents who were married to each other at the time of the child's birth.",
      ).selects,
    ).toBe(
      "Child was born to parents who were married to each other at the time of the child's birth",
    );
  });

  it("does not stop an option at an abbreviation's full stop", () => {
    // Cutting at the first period gave "Certain Employee or Former Employee of
    // the U" — a real option, silently truncated mid-word.
    expect(
      parseTooltip(
        "Part 2. Application Type or Filing Category. 3.c. Special Immigrant. Select Certain Employee or Former Employee of the U.S. Government Abroad, DS-1884.",
      ).selects,
    ).toBe("Certain Employee or Former Employee of the U.S. Government Abroad, DS-1884");
  });

  it("does not mistake an instruction about the control for an option", () => {
    const { selects, question } = parseTooltip(
      "To be completed by an attorney or accredited representative, if any. Select this box if Form G - 28 is attached.",
    );
    expect(selects).toBeNull();
    // And the instruction stays in the label, because removing it would leave
    // the field with nothing to read.
    expect(question).toContain("Select this box if Form G - 28 is attached.");
  });

  it("does not mistake a real option for an instruction because of its article", () => {
    // "The" and "A" begin genuine options on the I-485. Only a mention of the
    // *box* marks an instruction.
    expect(
      parseTooltip(
        "Part 2. Application Type or Filing Category. 3.f. Special Programs Based on Certain Public Laws. Select The Cuban Adjustment Act.",
      ).selects,
    ).toBe("The Cuban Adjustment Act");
  });

  it("ignores the word select used as prose", () => {
    // A dropdown's tooltip describes itself; there is no option being named.
    expect(
      parseTooltip(
        "Part 1. Information About You. 18. State. This is a drop-down list and you will select a state from a list of States.",
      ).selects,
    ).toBeNull();
  });

  it("survives a tooltip that names no part", () => {
    expect(parseTooltip("Enter the Additional Information.")).toEqual({
      part: null,
      title: null,
      question: "Enter the Additional Information.",
      selects: null,
    });
    expect(parseTooltip(null).question).toBe("");
  });
});

/**
 * Which checkbox an answer ticks.
 *
 * A choice prints as one checkbox per option, so filling one means comparing
 * the stored answer against the option the box was mapped to. The two are
 * written by different hands — a questionnaire says "Yes", an extractor read
 * "yes" off the blank's own tooltip — and a comparison strict enough to miss
 * that leaves the box blank, which on a filing reads as an answer of "no".
 */
describe("matching an answer to the box it marks", () => {
  it("treats the ways of writing yes and no as one answer each", () => {
    expect(canonicalAnswer("Yes")).toBe("yes");
    expect(canonicalAnswer("true")).toBe("yes");
    expect(canonicalAnswer("Y")).toBe("yes");
    expect(canonicalAnswer("1")).toBe("yes");
    expect(canonicalAnswer("No")).toBe("no");
    expect(canonicalAnswer("false")).toBe("no");
    expect(canonicalAnswer("0")).toBe("no");
  });

  it("ignores case and surrounding space in an option", () => {
    expect(sameAnswer("  Brother / Sister ", "brother / sister")).toBe(true);
  });

  it("collapses the run of spaces a wrapped tooltip leaves behind", () => {
    expect(sameAnswer("Stepchild /  Stepparent", "Stepchild / Stepparent")).toBe(
      true,
    );
  });

  it("keeps genuinely different options apart", () => {
    // The I-130's Part 1 item 1: four boxes, and only one may be ticked.
    expect(sameAnswer("Parent", "Child")).toBe(false);
    expect(sameAnswer("Yes", "No")).toBe(false);
    // "No" is an answer; a missing one is not.
    expect(sameAnswer("", "No")).toBe(false);
  });
});
