/**
 * Reading a USCIS AcroForm box name as the thing the form actually asks for.
 *
 * ─── Why this can be done at all ────────────────────────────────────────────
 *
 * USCIS names its boxes after the place on the page, not after some internal
 * id: `form1[0].#subform[0].Pt2Line4a_FamilyName[0]` is Part 2, Item 4.a.,
 * "Family Name". That is a grammar, and it holds across forms — which means the
 * catalogue of what a form contains can be *read off the blank* instead of
 * transcribed by hand from the PDF. Hand transcription is how the catalogue was
 * built before, and it is why the I-485 had 27 fields when the form has closer
 * to four hundred.
 *
 * Pure functions, no PDF and no database, so the grammar is unit-testable
 * against real names — which matters, because the grammar is not quite regular
 * and the exceptions are USCIS's, not ours. See `NAME_FIXES`.
 */

import type { questionnaireQuestionTypeEnum } from "../../db/schema/enums";

export type QuestionType =
  (typeof questionnaireQuestionTypeEnum.enumValues)[number];

/** What a box name turns out to mean. */
export type ParsedBoxName = {
  /**
   * The form's part number, e.g. `2` from `Pt2Line4a_FamilyName`.
   *
   * Null where the name carries no part at all — the I-765 names every box
   * `Line1a_FamilyName`, with the part only in the tooltip. The caller resolves
   * it, and the tooltip wins anyway wherever the two disagree.
   */
  part: number | null;
  /** The item number as printed, e.g. `4a`. Absent on a part-wide box. */
  line: string | null;
  /** What the box is for, still in the form's own camel case: `FamilyName`. */
  tail: string;
};

/**
 * USCIS's own naming slips, corrected before parsing.
 *
 * Every one of these is a real name on a real blank. They are listed rather
 * than absorbed into the grammar because a looser grammar would start matching
 * things that are not fields at all — and a name nobody anticipated should
 * surface as "unparsed, go look" rather than as a confidently wrong part
 * number.
 */
const NAME_FIXES: Record<string, string> = {
  // I-130: the part number is simply missing. Item 20.a. is in Part 2.
  PtLine20a_FamilyName: "Pt2Line20a_FamilyName",
  // I-485: the underscore before the item suffix is missing.
  Pt1Line18PriorDateTo: "Pt1Line18_PriorDateTo",
};

/**
 * Boxes that carry no question.
 *
 * `TextField1`, `CheckBox1` and friends are unnamed leftovers; the header boxes
 * repeat the same datum on every page, which a one-box-per-datum mapping cannot
 * express anyway. Excluded deliberately, and counted in the extractor's report
 * so their exclusion is visible rather than assumed.
 */
const NOT_A_QUESTION =
  /^(TextField\d*|CheckBox\d*|[a-z]_YesNo|AttorneyStateBarNumber|VolagNumber|USCISOnlineAcctNumber|AlienNumber|Signature.*)$/i;

/** `form1[0].#subform[0].Pt2Line4a_FamilyName[0]` → `Pt2Line4a_FamilyName`. */
export const leafName = (boxName: string) =>
  boxName.split(".").pop()!.replace(/\[\d+\]$/, "");

/**
 * The grammar: a part, optionally an item, then what the box is for.
 *
 * `Pt`, `Part` and `P` are all used, sometimes on the same form; `Line` and
 * `Item` likewise. The item number carries a letter suffix — `4a`, `3B` — which
 * is part of how the form prints it and is kept verbatim.
 */
const GRAMMAR = /^(?:Pt|Part|P)(\d+)_?(?:Line|Item)?_?(\d+[A-Za-z]?)?_?(.*)$/;

/**
 * The same grammar with the part missing entirely: `Line1a_FamilyName`.
 *
 * The I-765 names every box this way — 60 of its 154, and among them the whole
 * of Part 2's identity block, which is to say every field a questionnaire could
 * ever fill. They were being dropped as unparseable, so the form extracted 84
 * fields and none of them were a name, a date of birth or an A-number.
 *
 * Nothing is guessed by accepting them. Their tooltips are complete and carry
 * the part — "Part 2. Information About You. Your Full Legal Name. 1. A. Enter
 * Family Name" — and the caller already prefers the tooltip's part over the
 * name's wherever the two disagree.
 *
 * `Line`/`Item` is required here where it is optional above: with no part
 * prefix to anchor on, it is the only thing separating a real box from a stray
 * widget.
 */
const PARTLESS_GRAMMAR = /^(?:Line|Item)_?(\d+[A-Za-z]?)_?(.*)$/;

export function parseBoxName(boxName: string): ParsedBoxName | null {
  const leaf = NAME_FIXES[leafName(boxName)] ?? leafName(boxName);
  if (NOT_A_QUESTION.test(leaf)) return null;

  const match = GRAMMAR.exec(leaf);
  if (match && match[3]) {
    return {
      part: Number(match[1]),
      line: match[2] ? match[2].toLowerCase() : null,
      tail: match[3],
    };
  }

  const partless = PARTLESS_GRAMMAR.exec(leaf);
  if (partless && partless[2]) {
    return {
      part: null,
      line: partless[1].toLowerCase(),
      tail: partless[2],
    };
  }

  return null;
}

/**
 * What a box's `/TU` tooltip turns out to say.
 *
 * The tooltip is the printed question, and it is the source a label should come
 * from — the box *name* is an abbreviation of it at best (`Pt1Line3_DOB`) and
 * silent about the question at worst (`Pt8Line13_YesNo`). Everything below
 * exists to take the tooltip apart into the three things a catalogue needs,
 * without paraphrasing any of them.
 */
export type ParsedTooltip = {
  /** The *printed* part number, which is not always the one in the box name. */
  part: number | null;
  /** The part's own heading, before any sub-heading inside it. */
  title: string | null;
  /** Item number and question, verbatim — everything the part heading is not. */
  question: string;
  /**
   * The trailing screen-reader instruction naming *this widget*, e.g. `Female`
   * from "Select Female." It is what tells the two halves of a choice apart,
   * and it is not part of the question.
   */
  selects: string | null;
};

/**
 * Split a tooltip into part heading, question and widget instruction.
 *
 * Deliberately conservative: anything not confidently identified as heading or
 * instruction stays in `question`, because the instruction is "match the form
 * exactly" and a parser that guesses wrong silently rewrites a statutory
 * question.
 */
export function parseTooltip(tooltip: string | null): ParsedTooltip {
  const text = (tooltip ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { part: null, title: null, question: "", selects: null };

  // "… Select Female." / "… Select Child was born to parents who were married
  // to each other at the time of the child's birth." — a trailing imperative
  // naming what *this* widget selects. It is the last sentence, and it is not
  // part of the question: on a pair of checkboxes the two halves differ only
  // here, which is exactly what makes it the option list.
  //
  // Not bounded by length. The options run from "Male" to a full clause, and a
  // limit tight enough to exclude the false positives below also threw away
  // every long option on the I-130's Item 2.
  //
  // Nor anchored to the end of the tooltip. USCIS often continues past it —
  // "… Select Yes. If you answered 'Yes' to Item Number 1., complete Item
  // Numbers 2. - 9." — and that continuation is guidance about *the answer*,
  // present on one half of the pair and not the other. Keeping it would give
  // the two halves of one question two different texts, which is how a single
  // question ends up catalogued twice.
  //
  // It must begin a sentence: "you will select a state from a list of States"
  // is prose, and the dropdown it describes has no options to name.
  const selectMatch = /(?:^|(?<=[.?!])\s+)Select\s+/i.exec(text);
  let selects: string | null = null;
  let withoutSelect = text;

  if (selectMatch) {
    const prefix = text.slice(0, selectMatch.index).trim();
    const after = text.slice(selectMatch.index + selectMatch[0].length);
    const candidate = untilSentenceEnd(after);

    // "Select this box if Form G-28 is attached." is an instruction about the
    // control, not a name for it — as are "Select the box for either Item
    // Number 1.A. or 1.B." Those stay in the question, because removing them
    // would leave a field with nothing to read at all.
    //
    // The determiner alone does not settle it: "Select The Cuban Adjustment
    // Act." and "Select A Victim of Battery or Extreme Cruelty…" are real
    // options on the I-485. It is the word *box* that marks an instruction —
    // it refers to the control, and no option on either form contains it.
    const isInstruction =
      !candidate ||
      !prefix ||
      (/^(this|that|the|these|those|only|all|a|an|one)\b/i.test(candidate) &&
        /\bbox(es)?\b/i.test(candidate));

    if (!isInstruction) {
      selects = candidate;
      withoutSelect = prefix;
    }
  }

  const partMatch = /^Part\s+(\d+)\.\s*(.*)$/is.exec(withoutSelect);
  if (!partMatch) {
    return { part: null, title: null, question: withoutSelect, selects };
  }

  const part = Number(partMatch[1]);
  const rest = partMatch[2];

  // The heading runs until the item number — "3.", "4.a." — or, where the box
  // belongs to no numbered item, until the first sentence break.
  const item = /(?:^|[.)}]\s*)(\d+\.(?:[a-z]\.)?)(?=\s)/i.exec(rest);
  const headingEnd = item ? item.index : rest.indexOf(". ");
  const title =
    headingEnd >= 0
      ? tidyHeading(rest.slice(0, headingEnd))
      : tidyHeading(rest);

  const question =
    headingEnd >= 0 ? rest.slice(headingEnd).replace(/^[\s.)}]+/, "") : "";

  return { part, title, question, selects };
}

/**
 * Whether an answer and a mapping's value are the same answer.
 *
 * One place decides this, because two would eventually disagree: the extractor
 * uses it to keep a group's boxes distinct, and the fill uses it to choose
 * which box to mark. If they parted company, a form would be catalogued with
 * options nothing could ever match.
 *
 * Yes and no arrive spelled every way a form and a database can spell them —
 * `Y`, `true`, `1` from a boolean answer; `Yes` from the form's own wording —
 * and they all mean the same tick.
 */
export const canonicalAnswer = (value: string) => {
  const trimmed = value.trim();
  if (/^(y|yes|true|1)$/i.test(trimmed)) return "yes";
  if (/^(n|no|false|0)$/i.test(trimmed)) return "no";
  return trimmed.toLowerCase().replace(/\s+/g, " ");
};

export const sameAnswer = (a: string, b: string) =>
  canonicalAnswer(a) === canonicalAnswer(b);

/**
 * The first sentence of a fragment, where an abbreviation's dot is not the end.
 *
 * The options on these forms are full of them — "Certain Employee or Former
 * Employee of the U.S. Government Abroad, Form I-360" — and cutting at the
 * first period turns that into "Certain Employee or Former Employee of the U".
 * A dot straight after a lone capital belongs to an abbreviation; one after
 * anything else ends the sentence.
 */
const untilSentenceEnd = (text: string) => {
  const end = /(?<![A-Z])\.(?=\s|$)/.exec(text);
  return (end ? text.slice(0, end.index) : text).trim();
};

/**
 * USCIS truncates its own headings mid-parenthesis — "Information About You
 * (Petitioner" — because the closing bracket falls where this splits. Closing
 * it back up is the one edit made to the form's words, and it is a repair
 * rather than a rewrite.
 *
 * Exported because the heading is split a second time when a part's boxes vote
 * on it — "Relationship (You are the Petitioner. Your relative is the
 * Beneficiary)" loses its bracket again at the sentence break — and a repair
 * that only runs once leaves the wart it was written to remove.
 */
export const tidyHeading = (heading: string) => {
  const trimmed = heading.replace(/[\s.}]+$/, "").trim();
  const opens = (trimmed.match(/\(/g) ?? []).length;
  const closes = (trimmed.match(/\)/g) ?? []).length;
  return opens > closes ? `${trimmed})` : trimmed;
};

/**
 * Abbreviations USCIS uses in box names, expanded for the label.
 *
 * Only where the short form is genuinely opaque on screen. `Num` → `Number` is
 * worth it; `Name` → `Name` is not, and a dictionary that tries to cover
 * everything ends up rewriting words it should have left alone.
 */
const EXPANSIONS: Record<string, string> = {
  dob: "Date of Birth",
  ssn: "Social Security Number",
  num: "Number",
  // No `no: "Number"`. USCIS writes `Num` for a number, and the standalone
  // word `No` is the other half of a yes/no — expanding it turned every
  // unnamed tick box into "Yes or Number".
  acct: "Account",
  act: "Account",
  tele: "Telephone",
  telephone: "Telephone",
  apt: "Apartment",
  ste: "Suite",
  flr: "Floor",
  exp: "Expiration",
  cb: "",
  yn: "",
  i94: "Form I-94",
  uscis: "USCIS",
  us: "U.S.",
  dv: "Diversity Visa",
  org: "Organization",
  info: "Information",
  doc: "Document",
  nonimm: "Nonimmigrant",
};

/** Words that stay lower case inside a label, the way a form prints them. */
const MINOR = new Set([
  "of",
  "or",
  "and",
  "the",
  "to",
  "in",
  "at",
  "for",
  "a",
  "an",
]);

/**
 * `4a` + `CityTownOfBirth` → `4.a. City/Town of Birth`.
 *
 * The item number is part of the label rather than a separate column, because
 * it is how a person cross-checks the screen against the paper — "Part 2, item
 * 4.a." is the only address a USCIS box really has.
 */
export function humanLabel(line: string | null, tail: string): string {
  const words = tail
    // USCIS does not capitalise its joining words, so camel case alone reads
    // `CountryofBirth` as one word. Break before a lower-case joiner that is
    // followed by a capital — which `Nationality` and `Information` are not,
    // because their `at` and `in` are not preceded by a lower-case letter or
    // not followed by a capital.
    .replace(/(?<=[a-z])(of|or|and|the|to|in|at|for)(?=[A-Z])/g, " $1 ")
    // Split camel case, including the acronym-to-word boundary: `USCISAccount`
    // has to break as `USCIS` + `Account`, not `USCI` + `SAccount`.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .flatMap((word) => {
      const expanded = EXPANSIONS[word.toLowerCase()];
      if (expanded === "") return [];
      return (expanded ?? word).split(" ");
    })
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && MINOR.has(lower)) return lower;
      // An expansion already carries its own casing (`U.S.`, `USCIS`), and so
      // does an acronym the form wrote in caps.
      return word;
    });

  const text = words.join(" ").replace(/\s+/g, " ").trim();
  // Trimmed again after the item number is put in front: a name that expands to
  // nothing at all (`YN`, `CB`) would otherwise leave a number and a space.
  return (line ? `${printedItem(line)} ${text}` : text).trim();
}

/** `4a` → `4.a.`, `18` → `18.` — the way the form numbers its own items. */
const printedItem = (line: string) => {
  const match = /^(\d+)([a-z])?$/.exec(line);
  if (!match) return `${line}.`;
  return match[2] ? `${match[1]}.${match[2]}.` : `${match[1]}.`;
};

/**
 * A stable key for a box that the shared vocabulary does not already name.
 *
 * Form-local on purpose: `i485.pt1.1_family_name` says where it is and nothing
 * about what it means, which is honest — a generated key has no claim to be the
 * same datum as anything on another form. Only a curated key
 * (`beneficiary.family_name`) makes that claim, and only a person can make it.
 *
 * Derived from the box, so re-running the extractor on the same edition
 * produces the same keys and the seed is an update rather than a churn of
 * deletes and inserts.
 */
export function fieldKeyFor(
  formCode: string,
  parsed: ParsedBoxName,
): string {
  const item = parsed.line ? `${parsed.line}_` : "";
  return `${formLocalPrefix(formCode)}.pt${parsed.part}.${item}${snake(parsed.tail)}`;
}

/**
 * The first segment of a generated key: the form's own code, compacted.
 *
 * `I-485` and `i485` are the same form, so the dash and the case are stripped
 * rather than trusted.
 *
 * ─── This used to answer a question it no longer answers ────────────────────
 *
 * `isSharedDatum(fieldKey, formCode)` lived here — whether a key named a datum
 * somebody asked for, or only a box on this one form — and the seed, the CRM's
 * coverage count and the mapper's overlay all read it. It is gone, because the
 * question now has a column: `form_field_definitions.schema_node_id` is null
 * exactly when the field carries no shared datum, and a foreign key cannot be
 * out of step with the vocabulary the way a rule about the shape of a string
 * could. Read the column.
 *
 * What is left here is the *naming* half, which is still a rule and not a
 * lookup: `fieldKeyFor` has to build a key before any row exists to bind, and
 * `clearGeneratedCatalogue` has to recognise its own output. Both are about how a
 * generated key is spelt, which is what this file is for.
 */
export const formLocalPrefix = (formCode: string) =>
  formCode.toLowerCase().replace(/[^a-z0-9]/g, "");

const snake = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/**
 * What kind of control the box wants.
 *
 * The PDF says text, checkbox or dropdown; the *label* says whether a text box
 * is a date, a phone number or an email, and getting that right is the
 * difference between a date picker and someone typing `03-14-1990` into a box
 * USCIS reads as mm/dd/yyyy.
 *
 * Read off the expanded label rather than the raw name on purpose. `OtherDOB`
 * contains no word "date" until the abbreviation is expanded, and matching
 * `dob` as a substring of a name is how `ArrivalDeparture` becomes a date
 * field. Whole words, after expansion, get both right.
 */
export function inferType(
  kind: "text" | "checkbox" | "dropdown",
  label: string,
  optionCount = 0,
): QuestionType {
  if (kind === "dropdown") return "dropdown";
  // Two named boxes under one item number are a choice between them — sex is
  // `Male`/`Female`, not a tick box. Only a lone box is a yes/no.
  if (kind === "checkbox") return optionCount > 1 ? "single_choice" : "yes_no";

  if (/\bdates?\b/i.test(label)) return "date";
  if (/\bemail\b/i.test(label)) return "email";
  if (/\b(telephone|phone|mobile|fax)\b/i.test(label)) return "phone";
  if (/\b(additional information|explanation|description|remarks)\b/i.test(label)) {
    return "long_text";
  }
  return "short_text";
}
