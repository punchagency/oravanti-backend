import { PDFDocument } from "@cantoo/pdf-lib";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  continuationBlocks,
  fillContinuation,
  findSlots,
  printedSlots,
  type RepeatGroupAnswer,
} from "../../../src/modules/workflow/continuation-sheet";

/*
  The overflow path, which has no visible failure mode.

  A client's third address either reaches Part 14 or it does not, and the form
  looks complete either way — USCIS reads the gap, months later, as an address
  that was not disclosed. So these assert the two things that can silently go
  wrong: how many entries the blank was believed to hold, and which Part and
  Item the continuation says it continues.
*/

/** The I-485's Part 1 Item 18 address blocks, as the field sources map them. */
const ADDRESS_MAPPINGS = [
  {
    fieldKey: "beneficiary.address_history[1].street",
    pdfFieldName: "form1[0].#subform[1].Pt1Line18_StreetNumberName[0]",
  },
  {
    fieldKey: "beneficiary.address_history[1].city",
    pdfFieldName: "form1[0].#subform[1].Pt1Line18_CityOrTown[0]",
  },
  {
    fieldKey: "beneficiary.address_history[2].street",
    pdfFieldName: "form1[0].#subform[1].Pt1Line18_PriorStreetName[0]",
  },
  { fieldKey: "beneficiary.date_of_birth", pdfFieldName: "Pt1Line10_DOB[0]" },
];

const ADDRESSES: RepeatGroupAnswer = {
  itemLabel: "Address",
  fields: [
    { key: "street", label: "Street number and name", type: "short_text" },
    { key: "city", label: "City or town", type: "short_text" },
    { key: "date_from", label: "Date from", type: "date" },
  ],
  entries: [
    { street: "1 Elm St", city: "Brooklyn", date_from: "2022-01-01" },
    { street: "2 Oak Ave", city: "Queens", date_from: "2019-06-01" },
    { street: "3 Pine Rd", city: "Newark", date_from: "2017-03-01" },
    { street: "4 Ash Ln", city: "Trenton" },
  ],
};

const pageOf = new Map([
  ["form1[0].#subform[1].Pt1Line18_PriorStreetName[0]", 1],
  ["form1[0].#subform[1].Pt1Line18_StreetNumberName[0]", 1],
]);

describe("how much room the blank has", () => {
  it("counts the highest entry each group is mapped for", () => {
    const slots = printedSlots(ADDRESS_MAPPINGS);
    expect(slots.get("beneficiary.address_history")).toBe(2);
  });

  it("ignores keys that name no entry", () => {
    // An ordinary field key is not a repeating one, and counting it as entry
    // zero of something would invent a group nobody asked about.
    expect(
      printedSlots(ADDRESS_MAPPINGS).has("beneficiary.date_of_birth"),
    ).toBe(false);
  });
});

describe("what overflows", () => {
  it("carries only the entries past the last printed block", () => {
    const blocks = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([["beneficiary.address_history", ADDRESSES]]),
      pageOfBox: pageOf,
    });

    expect(blocks.map((block) => block.source.index)).toEqual([3, 4]);
  });

  it("says which part, item and page it continues", () => {
    const [third] = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([["beneficiary.address_history", ADDRESSES]]),
      pageOfBox: pageOf,
    });

    // Read off the box the last printed entry maps to, not written by hand.
    expect(third.part).toBe("1");
    expect(third.item).toBe("18");
    // 1-based, because that is how a form numbers its pages.
    expect(third.page).toBe("2");
  });

  it("writes the entry out under the questionnaire's own labels", () => {
    const [third] = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([["beneficiary.address_history", ADDRESSES]]),
      pageOfBox: pageOf,
    });

    expect(third.text).toBe(
      [
        "Address 3 (continued)",
        "Street number and name: 3 Pine Rd",
        "City or town: Newark",
        "Date from: 2017-03-01",
      ].join("\n"),
    );
  });

  it("leaves out a sub-field the client did not answer", () => {
    // A blank line under a label reads as "asked and left empty", which is a
    // different claim from "not asked".
    const blocks = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([["beneficiary.address_history", ADDRESSES]]),
      pageOfBox: pageOf,
    });

    expect(blocks[1].text).not.toContain("Date from");
  });

  it("has nothing to carry when the entries fit", () => {
    const blocks = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([
        [
          "beneficiary.address_history",
          { ...ADDRESSES, entries: ADDRESSES.entries.slice(0, 2) },
        ],
      ]),
      pageOfBox: pageOf,
    });

    expect(blocks).toEqual([]);
  });
});

/*
  These four read a real I-485 blank, and there is no longer one in the repo —
  a form's PDF is uploaded by an operator and lives in object storage.

  Rather than delete assertions that caught a real bug once (the item-number
  pairing below), they read a directory named by `FORM_BLANKS_DIR` and skip when
  it is unset. Point it at a folder holding `i-485.pdf` before a pdf-lib upgrade
  or after re-extracting the form:

      FORM_BLANKS_DIR=../blanks npm run test:unit -- continuation-sheet

  Skipping is the honest default. A suite that silently passed because it had
  nothing to read would be worse than one that says it did not run.
*/
const BLANKS_DIR = process.env.FORM_BLANKS_DIR;

(BLANKS_DIR ? describe : describe.skip)(
  "the I-485's own continuation sheet (needs FORM_BLANKS_DIR)",
  () => {
  /*
    One document for the whole block, because parsing the real 1.2MB blank
    takes several seconds and doing it five times is most of this suite's
    runtime. The one test that writes runs last and reads its own writes, so
    sharing costs nothing.
  */
  let doc: PDFDocument;

  beforeAll(async () => {
    const blank = path.join(BLANKS_DIR ?? ".", "i-485.pdf");
    doc = await PDFDocument.load(await readFile(blank), { password: "" });
  }, 60_000);

  it("finds four blocks, each with its three label boxes", () => {
    const slots = findSlots(doc);

    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.page).toBeTruthy();
      expect(slot.part).toBeTruthy();
      expect(slot.item).toBeTruthy();
    }
  });

  it("pairs each block with the labels above it, not with its name index", () => {
    /*
      The trap this exists for. `Pt9Line3c_ItemNumber[0]` sits in Part 14's
      *first* block on the paper, while the extraction has it filed under Part
      8 — so reading the labels by their name index pairs every item number with
      the wrong block, and the form prints "continues Part 1 Item 18" against
      the wrong continuation. Geometry cannot disagree with what a person sees.
    */
    const slots = findSlots(doc);

    expect(slots[0].info).toContain("P14_Line2_AdditionalInfo");
    expect(slots[0].item).toContain("Pt9Line3c_ItemNumber[0]");
    expect(slots[1].info).toContain("P14_Line3_AdditionalInfo");
    expect(slots[1].item).toContain("Pt9Line3c_ItemNumber[1]");
  });

  it("touches nothing when there is no overflow", () => {
    expect(fillContinuation(doc, [])).toEqual({ written: 0, unplaced: [] });
  });

  // Last, because it writes into the shared document.
  it("writes what fits and names what does not", () => {
    const blocks = continuationBlocks({
      mappings: ADDRESS_MAPPINGS,
      groups: new Map([
        [
          "beneficiary.address_history",
          {
            ...ADDRESSES,
            // Two printed, seven answered: five overflow, four blocks.
            entries: [...ADDRESSES.entries, ...ADDRESSES.entries.slice(0, 3)],
          },
        ],
      ]),
      pageOfBox: pageOf,
    });

    const result = fillContinuation(doc, blocks);

    expect(result.written).toBe(4);
    expect(result.unplaced.map((block) => block.source.index)).toEqual([7]);

    const form = doc.getForm();
    expect(form.getTextField(findSlots(doc)[0].info).getText()).toContain(
      "3 Pine Rd",
    );
    expect(form.getTextField(findSlots(doc)[0].part!).getText()).toBe("1");
    expect(form.getTextField(findSlots(doc)[0].item!).getText()).toBe("18");
  });
});
