/**
 * The Family-Based Adjustment of Status case questionnaire.
 *
 * ─── What this seed is, and is not ──────────────────────────────────────────
 *
 * It is the questions. It is not the form catalogue, and on its own it prints
 * nothing.
 *
 * A form's fields come from one place and one place only: the blank PDF, which
 * an operator uploads in the CRM and which is read into
 * `form_field_definitions` on import. If a box is not on the blank it is not on
 * the form — 352 boxes on the I-130, 512 on the I-485, each with the printed
 * question USCIS wrote on it and the name of the box it lands in.
 *
 * Which gives this seed a prerequisite: Part 9's 117 eligibility questions are
 * the I-485's own wording, so they are read from that catalogue at run time and
 * the I-485 has to have been uploaded and imported first. The seed says so if
 * they are missing rather than quietly asking 117 fewer questions.
 *
 * This file used to declare a second, hand-written tier — thirty "shared"
 * fields listed against the six forms that print them. It was a good idea and
 * it had one fatal property: the hand-written list and the actual form were
 * different things, so a box nobody had thought to type up could never be
 * filled, and a field somebody typed up twice appeared on the form twice. The
 * form is the authority on what the form asks. That tier is gone.
 *
 * ─── What is left, and why it is still worth declaring by hand ──────────────
 *
 * `FIELDS` and `SECTIONS`: the *questions*, and the vocabulary they are asked
 * in. That is a different subject from a form's boxes, and no extractor can
 * write it — the whole point is that `beneficiary.date_of_birth` is asked once
 * and reaches every form that wants it, and deciding two boxes on two forms
 * want the same datum is a claim about meaning.
 *
 * The two meet in the CRM, on the PDF boxes screen, where somebody points a
 * curated key at a box. Until that happens the key asks a question that fills
 * nothing, and `seed-form-pdf-catalogue` reports it by name.
 *
 * ─── Two doors into the same tier ───────────────────────────────────────────
 *
 * Everything this seed writes is Oravanti's: `organizationId` is NULL on every
 * row, which is the same tier the CRM at `/platform` edits. The CLI is the bulk
 * door — it declares the questionnaire in one reviewable file — and the CRM is
 * the door for the one question somebody adds afterwards. Neither is a copy of
 * the other's data, so a re-run after an edit in the CRM overwrites that edit
 * on the keys it names.
 *
 * Idempotent. Safe to re-run; upserts on the natural keys.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { formFieldDefinitions } from "../schema/form-fields";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import type { LogicCondition } from "../../lib/questionnaire/logic";
import { questionnaireQuestionTypeEnum } from "../schema/enums";
import {
  questionnaireLogicRules,
  questionnaireQuestions,
  questionnaires,
  questionnaireSections,
} from "../schema/questionnaires";

type QType = (typeof questionnaireQuestionTypeEnum.enumValues)[number];

type FieldDef = {
  /** How the questionnaire asks for it, in the client's language. */
  question: string;
  /**
   * How the form prints it, where the form's own wording differs — and it
   * usually does. USCIS says "Family Name (Last Name)"; a questionnaire that
   * said the same would read like a form, which is the thing a questionnaire
   * exists to spare the client.
   */
  formLabel?: string;
  type: QType;
  /** Shown under the question. Reserved for what a client would actually get wrong. */
  help?: string;
  required?: boolean;
  config?: Record<string, unknown>;
};

const choices = (...options: string[]) => ({ options });

/**
 * The state codes the USCIS blanks' dropdowns hold, verbatim.
 *
 * Copied from the I-485 extraction rather than typed, because a choice has
 * to match the box's option string exactly — `canonicalAnswer` lowercases
 * and collapses whitespace and does nothing else. A list that said "New York"
 * would select nothing on a box whose option is "NY", and would look correct
 * on every screen in the app while doing it.
 */
const STATE_CODES = [
  "AA",
  "AE",
  "AK",
  "AL",
  "AP",
  "AR",
  "AS",
  "AZ",
  "CA",
  "CO",
  "CT",
  "DC",
  "DE",
  "FL",
  "FM",
  "GA",
  "GU",
  "HI",
  "IA",
  "ID",
  "IL",
  "IN",
  "KS",
  "KY",
  "LA",
  "MA",
  "MD",
  "ME",
  "MH",
  "MI",
  "MN",
  "MO",
  "MP",
  "MS",
  "MT",
  "NC",
  "ND",
  "NE",
  "NH",
  "NJ",
  "NM",
  "NV",
  "NY",
  "OH",
  "OK",
  "OR",
  "PA",
  "PR",
  "PW",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VA",
  "VI",
  "VT",
  "WA",
  "WI",
  "WV",
  "WY",
];

/**
 * The eligibility and inadmissibility questions, taken from the blank.
 *
 * ─── Why these are not written out by hand like every other question ────────
 *
 * Part 9 of the I-485 is 172 boxes and 87 distinct questions, and every one of
 * them is a statutory ground of inadmissibility. "Have you EVER been arrested,
 * cited, charged, or permitted to participate in a diversion program" is not
 * long because USCIS is verbose — each of those words admits or excludes a
 * category of person, and a friendlier paraphrase is a different question with
 * a different answer. A client who says "no" to a paraphrase has not answered
 * what the form asks, and the signature block above it says they have.
 *
 * So the wording is the blank's, verbatim, and it arrives the same way the box
 * mappings do: read off the uploaded PDF into `form_field_definitions`. The
 * rule the whole catalogue runs on — if it is not on the blank it is not on the
 * form — applies in this direction too.
 *
 * ─── Why no curated key ─────────────────────────────────────────────────────
 *
 * A curated key claims that two boxes on two forms want the same datum. These
 * boxes are on one form, are asked once, and are shared with nothing: the
 * question `i485.pt9.25a_yes_no` fills the box `i485.pt9.25a_yes_no` and no
 * other. The generated key is already the right key, so population's ordinary
 * shared-key route fills them with no wiring at all and there is nothing to
 * keep in step.
 *
 * ─── The grouping ──────────────────────────────────────────────────────────
 *
 * USCIS prefixes many of these with a theme — "Security and Related.",
 * "Criminal Acts and Violations." — and those prefixes are the only structure
 * the blank offers. Where one is present it becomes the section; everything
 * else goes in one section named as the part is. Eighty-seven questions under a
 * single heading is a wall, and the themes are the form's own answer to that.
 */
const SECURITY_PART = "Part 9.";

/** The form Part 9 belongs to. Read from the catalogue, so it needs the code. */
const SECURITY_FORM = "I-485";

/**
 * How many of them go in one section.
 *
 * There are 117, they are all yes/no, and they are the last thing a client
 * does. One section of 117 is a scroll bar nobody reaches the end of and a
 * progress figure that does not move; twenty is about a screen, and finishing
 * one is visible progress.
 *
 * Chunked by USCIS's own item numbers rather than by theme. The tooltips name a
 * theme on five boxes out of 117 — enough to produce three sections with one
 * question in them and one with a hundred — and inventing the grouping instead
 * would mean asserting a legal taxonomy of the inadmissibility grounds, which
 * is not a thing to guess at in a section heading. An item range is checkable
 * against the paper.
 */
const SECURITY_PER_SECTION = 20;

type SecuritySection = { title: string; description: string; fields: string[] };

/** The item number a Part 9 key carries: `i485.pt9.24a_yes_no` is item 24a. */
function itemNumber(fieldKey: string): { n: number; suffix: string } {
  const match = /\.pt9\.(\d+)([a-z]*)/.exec(fieldKey);
  return match
    ? { n: Number(match[1]), suffix: match[2] }
    : { n: Number.MAX_SAFE_INTEGER, suffix: "" };
}

/**
 * Read Part 9 off the extraction, as questions.
 *
 * Only `yes_no` boxes become questions. The part also holds the free-text
 * "explain" boxes that follow a yes, and the item-number references they are
 * keyed to; those are a continuation-sheet problem rather than a question, and
 * asking a client to fill one before they have said yes to anything is worse
 * than not asking.
 */
async function securityQuestions(): Promise<{
  fields: Record<string, FieldDef>;
  sections: SecuritySection[];
}> {
  /*
    Read out of the catalogue, not out of a file.

    This used to open `src/db/seeds/data/i-485.form-fields.json` — the committed
    extraction — and that file is gone with the rest of the repo's copy of the
    forms. `form_field_definitions` is the catalogue now, written when an
    operator uploads the I-485's blank and imports it, so that is where Part 9
    is read from.

    Which means this seed has a prerequisite it did not used to have, and the
    prerequisite is an operator action rather than another seed. That is stated
    rather than crashed on: an empty result here is a questionnaire missing 117
    eligibility questions, which is a filing defect, so the caller is told in a
    sentence naming what to do.
  */
  const rows = await db
    .select({
      fieldKey: formFieldDefinitions.fieldKey,
      label: formFieldDefinitions.label,
      partLabel: formFieldDefinitions.partLabel,
      type: formFieldDefinitions.type,
      orderIndex: formFieldDefinitions.orderIndex,
    })
    .from(formFieldDefinitions)
    .where(eq(formFieldDefinitions.formCode, SECURITY_FORM));

  const boxes = rows
    .filter(
      (box) =>
        (box.partLabel ?? "").startsWith(SECURITY_PART) && box.type === "yes_no",
    )
    .sort((a, b) => {
      const left = itemNumber(a.fieldKey);
      const right = itemNumber(b.fieldKey);
      return (
        left.n - right.n ||
        left.suffix.localeCompare(right.suffix) ||
        a.orderIndex - b.orderIndex
      );
    });

  const fields: Record<string, FieldDef> = {};
  for (const box of boxes) {
    /*
      The leading item number is stripped and the question is not. The number
      refers to a line on a form the client is not looking at; the sentence
      after it is the thing that must survive untouched, because a friendlier
      paraphrase of a statutory ground is a different question.
    */
    const question = box.label
      .replace(/^\s*[A-Z][A-Za-z, ]+?\.\s+(?=\d)/, "")
      .replace(/^\s*(?:Do you intend to:|Have you EVER:)\s*/, "")
      .replace(/^\s*\d+\.?\s*(?:[A-Za-z]\.\s*)?/, "")
      .trim();

    fields[box.fieldKey] = {
      question: question || box.label,
      formLabel: box.label,
      type: "yes_no",
      required: true,
    };
  }

  const sections: SecuritySection[] = [];
  const total = Math.ceil(boxes.length / SECURITY_PER_SECTION);

  for (let i = 0; i < boxes.length; i += SECURITY_PER_SECTION) {
    const chunk = boxes.slice(i, i + SECURITY_PER_SECTION);
    const index = sections.length + 1;
    const first = itemNumber(chunk[0].fieldKey);
    const last = itemNumber(chunk[chunk.length - 1].fieldKey);

    sections.push({
      title: `Eligibility questions (${index} of ${total})`,
      description:
        index === 1
          ? `Items ${first.n} to ${last.n} of Part 9. Please answer every one, and answer honestly. A truthful yes is very often survivable — there is a waiver for most of these, and your attorney can only ask for one they know about. A no that turns out to be wrong is a misrepresentation on a signed federal form, which is not.`
          : `Items ${first.n} to ${last.n} of Part 9.`,
      fields: chunk.map((box) => box.fieldKey),
    });
  }

  return { fields, sections };
}

// ─── The shared vocabulary ───────────────────────────────────────────────────

export const FIELDS: Record<string, FieldDef> = {
  // ── The person adjusting status ───────────────────────────────────────────
  "beneficiary.family_name": {
    question: "Your last name (family name)",
    formLabel: "Family Name (Last Name)",
    type: "short_text",
    required: true,
    help: "Exactly as it appears on your passport, including any hyphens.",
  },
  "beneficiary.given_name": {
    question: "Your first name (given name)",
    formLabel: "Given Name (First Name)",
    type: "short_text",
    required: true,
  },
  "beneficiary.middle_name": {
    question: "Your middle name, if you have one",
    formLabel: "Middle Name",
    type: "short_text",
  },
  "beneficiary.other_names_used": {
    question: "Any other names you have used",
    formLabel: "Other Names Used",
    type: "long_text",
    help: "Maiden name, names from a previous marriage, nicknames used on official documents. Leave blank if none.",
  },
  "beneficiary.date_of_birth": {
    question: "Your date of birth",
    formLabel: "Date of Birth (mm/dd/yyyy)",
    type: "date",
    required: true,
  },
  "beneficiary.city_of_birth": {
    question: "City or town where you were born",
    formLabel: "City/Town/Village of Birth",
    type: "short_text",
    required: true,
  },
  "beneficiary.country_of_birth": {
    question: "Country where you were born",
    formLabel: "Country of Birth",
    type: "short_text",
    required: true,
    help: "The country as it is named today, even if it had a different name when you were born.",
  },
  "beneficiary.country_of_citizenship": {
    question: "Your country of citizenship",
    formLabel: "Country of Citizenship or Nationality",
    type: "short_text",
    required: true,
  },
  "beneficiary.sex": {
    question: "Sex as shown on your passport",
    formLabel: "Sex",
    type: "single_choice",
    required: true,
    config: choices("Male", "Female"),
  },
  "beneficiary.alien_number": {
    question: "Your A-Number, if you have one",
    formLabel: "Alien Registration Number (A-Number)",
    type: "short_text",
    help: "A nine-digit number beginning with A, on any notice USCIS has sent you. Leave blank if you have never had one.",
  },
  "beneficiary.uscis_online_account_number": {
    question: "Your USCIS online account number, if you have one",
    formLabel: "USCIS Online Account Number",
    type: "short_text",
  },
  "beneficiary.ssn": {
    question: "Your Social Security number, if you have one",
    formLabel: "U.S. Social Security Number",
    type: "short_text",
  },
  "beneficiary.marital_status": {
    question: "Your marital status",
    formLabel: "Current Marital Status",
    type: "single_choice",
    required: true,
    /*
      The form's own words, not ours. `sameAnswer` compares an answer to the
      box's value verbatim, so a questionnaire offering "Single" marks nothing
      on a form whose box says "Single, Never Married" — and reports that it
      could not, which is the good failure but still a blank on a filing.

      These are the I-485's six. The I-130 asks the same question in different
      words ("Separated", "Annulled" against "Legally Separated", "Marriage
      Annulled"), so its box is deliberately NOT in i-130.field-sources.json:
      four of six would tick and two would silently not, and a marital status
      that is right two thirds of the time is worse than one a person fills in.
      Wire it by hand, or give the mapping a per-form alias — but not by
      quietly picking one form's vocabulary for both.
    */
    config: choices(
      "Single, Never Married",
      "Married",
      "Divorced",
      "Widowed",
      "Legally Separated",
      "Marriage Annulled",
    ),
  },

  // ── Where you live and how to reach you ───────────────────────────────────
  /*
    The first question in the bank that answers more than once.

    USCIS asks for five years of addresses and the I-485 prints two of them —
    the current one and one prior — with anything further belonging on Part 14.
    The questionnaire deliberately takes as many as the client has: the
    continuation sheet is not built yet, and the answer to that is to write the
    sheet, not to stop asking. A gap in an address history is read by USCIS as
    an address that was not disclosed.

    Note this is the *physical* address history, which is not the mailing
    address below it. The I-485 asks for both and they are different boxes.
  */
  "beneficiary.address_history": {
    question: "Every address you have lived at in the last five years",
    formLabel: "Physical Address",
    type: "repeat_group",
    required: true,
    help: "Start with where you live now and work backwards. Do not leave a gap between them — an unexplained gap is treated as an address you did not tell us about.",
    config: {
      itemLabel: "Address",
      fields: [
        {
          key: "street",
          label: "Street number and name",
          type: "short_text",
          required: true,
        },
        {
          key: "unit_number",
          label: "Apartment, suite or floor number",
          type: "short_text",
        },
        {
          key: "in_care_of",
          label: "In care of name, if any",
          type: "short_text",
        },
        {
          key: "city",
          label: "City or town",
          type: "short_text",
          required: true,
        },
        // Two-letter codes, and the same list the blank's dropdown holds.
        {
          key: "state",
          label: "State",
          type: "dropdown",
          config: { options: STATE_CODES },
        },
        { key: "zip", label: "ZIP code", type: "short_text" },
        {
          key: "province",
          label: "Province, if outside the United States",
          type: "short_text",
        },
        {
          key: "postal_code",
          label: "Postal code, if outside the United States",
          type: "short_text",
        },
        { key: "country", label: "Country", type: "short_text" },
        {
          key: "date_from",
          label: "Lived here from",
          type: "date",
          required: true,
        },
        { key: "date_to", label: "Lived here until", type: "date" },
      ],
    },
  },

  /*
    The safe or alternate mailing address, which is what the boxes these fill
    actually are — not a second copy of the address above. A client whose post
    goes to their home leaves all five blank.
  */
  "beneficiary.mailing_address.street": {
    question:
      "Street address, if your post goes somewhere other than where you live",
    formLabel: "Street Number and Name",
    type: "short_text",
  },
  "beneficiary.mailing_address.unit": {
    question: "Apartment, suite or floor",
    formLabel: "Apt./Ste./Flr.",
    type: "short_text",
  },
  "beneficiary.mailing_address.city": {
    question: "City or town",
    formLabel: "City or Town",
    type: "short_text",
    required: true,
  },
  "beneficiary.mailing_address.state": {
    question: "State",
    formLabel: "State",
    // A dropdown of the blank's own codes rather than free text: the box is
    // a dropdown, and "New York" typed into it selects nothing at all.
    type: "dropdown",
    config: { options: STATE_CODES },
  },
  "beneficiary.mailing_address.zip": {
    question: "ZIP code",
    formLabel: "ZIP Code",
    type: "short_text",
    required: true,
  },
  "beneficiary.daytime_phone": {
    question: "Daytime phone number",
    formLabel: "Daytime Telephone Number",
    type: "phone",
    required: true,
  },
  "beneficiary.email": {
    question: "Email address",
    formLabel: "Email Address",
    type: "email",
    required: true,
  },

  // ── How you entered the United States ─────────────────────────────────────
  "beneficiary.passport_number": {
    question: "Passport number",
    formLabel: "Passport Number",
    type: "short_text",
    required: true,
  },
  "beneficiary.passport_country": {
    question: "Country that issued your passport",
    formLabel: "Country of Issuance for Passport",
    type: "short_text",
    required: true,
  },
  "beneficiary.i94_number": {
    question: "Your most recent I-94 number",
    formLabel: "Form I-94 Arrival-Departure Record Number",
    type: "short_text",
    help: "Find it at i94.cbp.dhs.gov if you do not have the paper card.",
  },
  "beneficiary.date_of_last_arrival": {
    question: "Date you last entered the United States",
    formLabel: "Date of Last Arrival (mm/dd/yyyy)",
    type: "date",
    required: true,
  },
  "beneficiary.place_of_last_arrival": {
    question: "Place you last entered the United States",
    formLabel: "Place of Last Arrival",
    type: "short_text",
    required: true,
    help: "The airport or border crossing, e.g. “JFK, New York”.",
  },
  "beneficiary.status_at_last_arrival": {
    question: "The status you were admitted in",
    formLabel: "Status at Last Arrival",
    type: "short_text",
    required: true,
    help: "The visa class on your entry stamp, e.g. B-2, F-1, K-1.",
  },
  "beneficiary.current_immigration_status": {
    question: "Your immigration status now",
    formLabel: "Current Immigration Status",
    type: "short_text",
    required: true,
  },

  // ── Your spouse, the petitioner ───────────────────────────────────────────
  "petitioner.family_name": {
    question: "Your spouse's last name",
    formLabel: "Petitioner's Family Name (Last Name)",
    type: "short_text",
    required: true,
  },
  "petitioner.given_name": {
    question: "Your spouse's first name",
    formLabel: "Petitioner's Given Name (First Name)",
    type: "short_text",
    required: true,
  },
  "petitioner.middle_name": {
    question: "Your spouse's middle name, if any",
    formLabel: "Petitioner's Middle Name",
    type: "short_text",
  },
  "petitioner.date_of_birth": {
    question: "Your spouse's date of birth",
    formLabel: "Petitioner's Date of Birth (mm/dd/yyyy)",
    type: "date",
    required: true,
  },
  "petitioner.country_of_birth": {
    question: "Country where your spouse was born",
    formLabel: "Petitioner's Country of Birth",
    type: "short_text",
    required: true,
  },
  "petitioner.citizenship_status": {
    question: "Your spouse's status in the United States",
    formLabel: "Petitioner's Status",
    type: "single_choice",
    required: true,
    config: choices("U.S. citizen", "Lawful permanent resident"),
    help: "This decides whether a visa number is available now or you must wait — it is the single most consequential answer here.",
  },
  "petitioner.alien_number": {
    question: "Your spouse's A-Number, if they are a permanent resident",
    formLabel: "Petitioner's A-Number",
    type: "short_text",
  },
  "petitioner.ssn": {
    question: "Your spouse's Social Security number",
    formLabel: "Petitioner's U.S. Social Security Number",
    type: "short_text",
    required: true,
  },
  "petitioner.daytime_phone": {
    question: "Your spouse's daytime phone number",
    formLabel: "Petitioner's Daytime Telephone Number",
    type: "phone",
    required: true,
  },
  "petitioner.email": {
    question: "Your spouse's email address",
    formLabel: "Petitioner's Email Address",
    type: "email",
  },

  // ── The marriage ──────────────────────────────────────────────────────────
  "marriage.date": {
    question: "Date you married",
    formLabel: "Date of Marriage (mm/dd/yyyy)",
    type: "date",
    required: true,
  },
  "marriage.city": {
    question: "City or town where you married",
    formLabel: "City or Town of Marriage",
    type: "short_text",
    required: true,
  },
  "marriage.state": {
    question: "State or province where you married",
    formLabel: "State or Province of Marriage",
    type: "short_text",
  },
  "marriage.country": {
    question: "Country where you married",
    formLabel: "Country of Marriage",
    type: "short_text",
    required: true,
  },
  "marriage.prior_marriages_beneficiary": {
    question: "Have you been married before?",
    formLabel: "Applicant's Prior Marriages",
    type: "yes_no",
    required: true,
    help: "If yes, every previous marriage must be shown to have legally ended before this one began.",
  },
  "marriage.prior_marriages_petitioner": {
    question: "Has your spouse been married before?",
    formLabel: "Petitioner's Prior Marriages",
    type: "yes_no",
    required: true,
  },

  // ── Work permission (I-765) ───────────────────────────────────────────────
  "employment.eligibility_category": {
    question: "Do you want permission to work while your case is pending?",
    formLabel: "Eligibility Category",
    type: "yes_no",
    required: true,
    help: "Almost everyone with a pending adjustment says yes. It is filed as category (c)(9) and costs nothing extra alongside the I-485.",
  },

  // ── Travel permission (I-131) ─────────────────────────────────────────────
  "travel.intends_to_travel": {
    question:
      "Do you expect to travel outside the United States while your case is pending?",
    formLabel: "Application Type",
    type: "yes_no",
    required: true,
    help: "Leaving without advance parole abandons the application. Say yes if there is any chance, since it costs nothing to have and cannot be obtained quickly later.",
  },
  "travel.purpose": {
    question: "If you may travel, what for?",
    formLabel: "Purpose of Trip",
    type: "long_text",
  },
  "travel.countries_intended": {
    question: "Which countries would you visit?",
    formLabel: "Countries to be Visited",
    type: "short_text",
  },

  // ── The affidavit of support (I-864) ──────────────────────────────────────
  "sponsor.household_size": {
    question: "How many people does your spouse's household support?",
    formLabel: "Sponsor's Household Size",
    type: "number",
    required: true,
    help: "Count your spouse, you, any children, and anyone else claimed as a dependent on their tax return.",
  },
  "sponsor.annual_income": {
    question: "Your spouse's current annual income",
    formLabel: "Sponsor's Current Annual Household Income",
    type: "number",
    required: true,
    help: "Must reach 125% of the federal poverty guideline for the household size above, or a joint sponsor is needed.",
  },
  "sponsor.has_joint_sponsor": {
    question: "Will someone else also sponsor you financially?",
    formLabel: "Joint Sponsor",
    type: "yes_no",
    required: true,
  },

  // ── The medical examination (I-693) ───────────────────────────────────────
  "medical.exam_date": {
    question:
      "Date of your immigration medical examination, if you have had it",
    formLabel: "Date of Examination (mm/dd/yyyy)",
    type: "date",
    help: "It must be performed by a USCIS-designated civil surgeon — a doctor's own physical will not be accepted.",
  },
  "medical.civil_surgeon_name": {
    question: "Name of the civil surgeon who examined you",
    formLabel: "Civil Surgeon's Name",
    type: "short_text",
  },

  // ── The petitioning spouse's address (I-130 Part 2, I-864 Part 2) ─────────
  //
  // The sponsor on the I-864 *is* the petitioner on the I-130 in a family-based
  // adjustment, so this is asked once and prints on both.
  "petitioner.mailing_address.street": {
    question: "Your spouse's street address",
    formLabel: "Street Number and Name",
    type: "short_text",
    required: true,
  },
  "petitioner.mailing_address.unit": {
    question: "Apartment, suite or floor",
    formLabel: "Apt./Ste./Flr.",
    type: "short_text",
  },
  "petitioner.mailing_address.in_care_of": {
    question: "In care of name, if any",
    formLabel: "In Care Of Name",
    type: "short_text",
  },
  "petitioner.mailing_address.city": {
    question: "City or town",
    formLabel: "City or Town",
    type: "short_text",
    required: true,
  },
  "petitioner.mailing_address.state": {
    question: "State",
    formLabel: "State",
    type: "dropdown",
    config: { options: STATE_CODES },
  },
  "petitioner.mailing_address.zip": {
    question: "ZIP code",
    formLabel: "ZIP Code",
    type: "short_text",
  },
  "petitioner.mailing_address.province": {
    question: "Province, if outside the United States",
    formLabel: "Province",
    type: "short_text",
  },
  "petitioner.mailing_address.postal_code": {
    question: "Postal code, if outside the United States",
    formLabel: "Postal Code",
    type: "short_text",
  },
  "petitioner.mailing_address.country": {
    question: "Country",
    formLabel: "Country",
    type: "short_text",
  },
  "petitioner.address_history": {
    question: "Every address your spouse has lived at in the last five years",
    formLabel: "Physical Address",
    type: "repeat_group",
    help: "Only needed if their post goes somewhere other than where they live, or if they have moved in the last five years.",
    config: {
      itemLabel: "Address",
      fields: [
        {
          key: "street",
          label: "Street number and name",
          type: "short_text",
          required: true,
        },
        {
          key: "unit_number",
          label: "Apartment, suite or floor number",
          type: "short_text",
        },
        {
          key: "city",
          label: "City or town",
          type: "short_text",
          required: true,
        },
        {
          key: "state",
          label: "State",
          type: "dropdown",
          config: { options: STATE_CODES },
        },
        { key: "zip", label: "ZIP code", type: "short_text" },
        {
          key: "province",
          label: "Province, if outside the United States",
          type: "short_text",
        },
        {
          key: "postal_code",
          label: "Postal code, if outside the United States",
          type: "short_text",
        },
        { key: "country", label: "Country", type: "short_text" },
        {
          key: "date_from",
          label: "Lived here from",
          type: "date",
          required: true,
        },
        { key: "date_to", label: "Lived here until", type: "date" },
      ],
    },
  },

  // ── Biographic details (I-485 Part 8) ─────────────────────────────────────
  //
  // Every option list below is the blank's own, copied from the extraction.
  // `canonicalAnswer` compares verbatim, so "Hazel" typed by hand somewhere
  // else selects nothing on a box whose option is "Hazel " — and looks right on
  // every screen in this app while doing it.
  "biographic.ethnicity": {
    question: "Ethnicity",
    formLabel: "Ethnicity",
    type: "single_choice",
    required: true,
    help: "USCIS asks this of everyone and uses it for statistics only. It has no effect on the decision.",
    config: choices("Hispanic or Latino", "Not Hispanic or Latino"),
  },
  "biographic.race": {
    question: "Race",
    formLabel: "Race",
    type: "multiple_choice",
    required: true,
    help: "Select every one that applies.",
    config: choices(
      "Asian",
      "White",
      "Black or African American",
      "American Indian or Alaska Native",
      "Native Hawaiian or Other Pacific Islander",
    ),
  },
  "biographic.height_feet": {
    question: "Height — feet",
    formLabel: "Height (Feet)",
    type: "dropdown",
    required: true,
    config: choices("2", "3", "4", "5", "6", "7", "8"),
  },
  "biographic.height_inches": {
    question: "Height — inches",
    formLabel: "Height (Inches)",
    type: "dropdown",
    required: true,
    config: choices(
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ),
  },
  "biographic.weight_lbs": {
    question: "Weight, in pounds",
    formLabel: "Weight (Pounds)",
    type: "number",
    required: true,
  },
  "biographic.eye_color": {
    question: "Eye colour",
    formLabel: "Eye Color",
    type: "single_choice",
    required: true,
    config: choices(
      "Blue",
      "Black",
      "Brown",
      "Gray",
      "Green",
      "Hazel",
      "Maroon",
      "Pink",
      "Unknown / Other",
    ),
  },
  "biographic.hair_color": {
    question: "Hair colour",
    formLabel: "Hair Color",
    type: "single_choice",
    required: true,
    config: choices(
      "Bald (No hair)",
      "Black",
      "Blond",
      "Brown",
      "Gray",
      "Red",
      "Sandy",
      "White",
      "Unknown / Other",
    ),
  },

  // ── Your parents (I-485 Part 5) ───────────────────────────────────────────
  //
  // Two, and the blank has room for exactly two — "Parent 1" and "Parent 2".
  // A repeating question rather than sixteen flat fields because they are the
  // same eight questions asked twice, and because a client with one parent to
  // name should not be looking at eight empty boxes for a second.
  "family.parents": {
    question: "Your parents",
    formLabel: "Parent",
    type: "repeat_group",
    required: true,
    help: "Give both parents if you can, whether or not they are living, and whether or not they are in the United States.",
    config: {
      itemLabel: "Parent",
      maxItems: 2,
      fields: [
        {
          key: "family_name",
          label: "Last name (family name)",
          type: "short_text",
          required: true,
        },
        {
          key: "given_name",
          label: "First name (given name)",
          type: "short_text",
          required: true,
        },
        { key: "middle_name", label: "Middle name", type: "short_text" },
        {
          key: "birth_family_name",
          label: "Last name at birth, if different",
          type: "short_text",
        },
        {
          key: "birth_given_name",
          label: "First name at birth, if different",
          type: "short_text",
        },
        {
          key: "birth_middle_name",
          label: "Middle name at birth, if different",
          type: "short_text",
        },
        { key: "date_of_birth", label: "Date of birth", type: "date" },
        {
          key: "country_of_birth",
          label: "Country of birth",
          type: "short_text",
        },
      ],
    },
  },

  // ── Your children (I-485 Part 7) ──────────────────────────────────────────
  "family.has_children": {
    question: "Do you have any living children?",
    type: "yes_no",
    required: true,
    help: "Every living child anywhere in the world, of any age, married or not — including stepchildren and adopted children.",
  },
  "family.children": {
    question: "Your children",
    formLabel: "Child",
    type: "repeat_group",
    config: {
      itemLabel: "Child",
      fields: [
        {
          key: "family_name",
          label: "Last name (family name)",
          type: "short_text",
          required: true,
        },
        {
          key: "given_name",
          label: "First name (given name)",
          type: "short_text",
          required: true,
        },
        { key: "middle_name", label: "Middle name", type: "short_text" },
        {
          key: "alien_number",
          label: "Alien Registration Number (A-Number), if any",
          type: "short_text",
        },
        {
          key: "date_of_birth",
          label: "Date of birth",
          type: "date",
          required: true,
        },
        {
          key: "country_of_birth",
          label: "Country of birth",
          type: "short_text",
          required: true,
        },
        {
          key: "relationship",
          label: "Relationship to you",
          type: "short_text",
          required: true,
        },
        {
          key: "applying_separately",
          label: "Is this child also applying now, on their own Form I-485?",
          type: "yes_no",
        },
      ],
    },
  },

  // ── Marital history (I-485 Part 6) ────────────────────────────────────────
  //
  // `times_married` is the box the old `prior_marriages_*` yes/no could never
  // fill: USCIS asks *how many times*, and a yes/no pointed at it printed a
  // tick where a number belongs.
  "marriage.times_married": {
    question: "How many times have you been married, including this marriage?",
    formLabel: "Number of Marriages",
    type: "number",
    required: true,
    help: "Count marriages that ended in divorce, annulment or death, and marriages abroad.",
  },
  "marriage.prior_spouses": {
    question: "Your earlier marriages",
    formLabel: "Prior Spouse",
    type: "repeat_group",
    help: "Each one must be shown to have legally ended before this marriage began, so please give the dates as exactly as you can.",
    config: {
      itemLabel: "Earlier marriage",
      fields: [
        {
          key: "family_name",
          label: "Their last name before the marriage",
          type: "short_text",
          required: true,
        },
        {
          key: "given_name",
          label: "Their first name",
          type: "short_text",
          required: true,
        },
        { key: "middle_name", label: "Their middle name", type: "short_text" },
        { key: "date_of_birth", label: "Their date of birth", type: "date" },
        {
          key: "country_of_birth",
          label: "Their country of birth",
          type: "short_text",
        },
        {
          key: "country_of_citizenship",
          label: "Their country of citizenship",
          type: "short_text",
        },
        {
          key: "marriage_date",
          label: "Date you married",
          type: "date",
          required: true,
        },
        {
          key: "marriage_city",
          label: "City or town where you married",
          type: "short_text",
        },
        {
          key: "marriage_state",
          label: "State or province where you married",
          type: "short_text",
        },
        {
          key: "marriage_country",
          label: "Country where you married",
          type: "short_text",
        },
        {
          key: "ended_date",
          label: "Date the marriage legally ended",
          type: "date",
          required: true,
        },
        {
          key: "ended_city",
          label: "City or town where it ended",
          type: "short_text",
        },
        {
          key: "ended_state",
          label: "State or province where it ended",
          type: "short_text",
        },
        {
          key: "ended_country",
          label: "Country where it ended",
          type: "short_text",
        },
        {
          key: "how_ended",
          label: "How it ended",
          type: "single_choice",
          required: true,
          config: {
            options: [
              "Divorced",
              "Spouse Deceased",
              "Annulled",
              "Other (Explain)",
            ],
          },
        },
        {
          key: "how_ended_other",
          label: "If other, please explain",
          type: "long_text",
        },
      ],
    },
  },

  // ── Work and school (I-485 Part 4, item 7) ────────────────────────────────
  "employment.history": {
    question: "Everywhere you have worked or studied in the last five years",
    formLabel: "Employment History",
    type: "repeat_group",
    required: true,
    help: "Most recent first, and please do not leave gaps. If you were unemployed, retired or a full-time carer, say so and tell us what you lived on — that is an answer USCIS accepts, and a gap is not.",
    config: {
      itemLabel: "Employer or school",
      fields: [
        {
          key: "employer_name",
          label: "Employer or school name",
          type: "short_text",
          required: true,
        },
        {
          key: "occupation",
          label: "Your job title or course",
          type: "short_text",
        },
        { key: "street", label: "Street number and name", type: "short_text" },
        {
          key: "unit_number",
          label: "Apartment, suite or floor number",
          type: "short_text",
        },
        { key: "city", label: "City or town", type: "short_text" },
        {
          key: "state",
          label: "State",
          type: "dropdown",
          config: { options: STATE_CODES },
        },
        { key: "zip", label: "ZIP code", type: "short_text" },
        {
          key: "province",
          label: "Province, if outside the United States",
          type: "short_text",
        },
        {
          key: "postal_code",
          label: "Postal code, if outside the United States",
          type: "short_text",
        },
        { key: "country", label: "Country", type: "short_text" },
        { key: "date_from", label: "From", type: "date", required: true },
        { key: "date_to", label: "Until", type: "date" },
        {
          key: "support_source",
          label: "If unemployed or retired, what did you live on?",
          type: "short_text",
        },
      ],
    },
  },

  // ── Earlier immigration applications (I-485 Part 4, items 1 to 6) ─────────
  "immigration.applied_immigrant_visa_before": {
    question:
      "Have you ever applied for an immigrant visa at a U.S. embassy or consulate abroad?",
    type: "yes_no",
    required: true,
  },
  "immigration.consulate_city": {
    question: "Which embassy or consulate — city or town",
    formLabel: "City or Town",
    type: "short_text",
  },
  "immigration.consulate_country": {
    question: "Which embassy or consulate — country",
    formLabel: "Country",
    type: "short_text",
  },
  "immigration.decision": {
    question: "What was decided",
    formLabel: "Decision",
    type: "short_text",
    help: "For example: approved, refused, denied, withdrawn.",
  },
  "immigration.decision_date": {
    question: "Date of that decision",
    formLabel: "Date of Decision",
    type: "date",
  },
  "immigration.applied_for_residence_before": {
    question:
      "Have you previously applied for permanent residence while inside the United States?",
    type: "yes_no",
    required: true,
  },
  "immigration.lpr_rescinded": {
    question:
      "Have you ever held permanent resident status that was later taken away?",
    type: "yes_no",
    required: true,
  },

  // ── The sponsor's finances (I-864 Part 6) ─────────────────────────────────
  "sponsor.household_income": {
    question: "Your spouse's total annual household income",
    formLabel: "Current Annual Household Income",
    type: "number",
    help: "Their own income plus anyone else's they are counting towards the requirement.",
  },
  "sponsor.filed_tax_returns": {
    question:
      "Has your spouse filed a federal income tax return for each of the last three years?",
    type: "yes_no",
    required: true,
  },
  "sponsor.tax_returns": {
    question: "Your spouse's last three tax years",
    formLabel: "Federal Income Tax Return",
    type: "repeat_group",
    help: "Most recent first. The figure is the total income line of the return, not the take-home pay.",
    config: {
      itemLabel: "Tax year",
      maxItems: 3,
      fields: [
        {
          key: "tax_year",
          label: "Tax year",
          type: "short_text",
          required: true,
        },
        {
          key: "total_income",
          label: "Total income for that year",
          type: "number",
          required: true,
        },
      ],
    },
  },

  // ── The medical examination (I-693) ───────────────────────────────────────
  "medical.exam_completed": {
    question: "Have you had your immigration medical examination yet?",
    type: "yes_no",
    required: true,
    help: "It must be done by a USCIS-designated civil surgeon. If you have not had it, we will tell you when to book and with whom.",
  },

  /*
    Part 9's 117 questions are NOT here, and that is a change worth reading.

    They are the I-485's own wording, so they come from the I-485's catalogue —
    which is a database read now rather than a committed file, and so cannot
    happen while this module is being loaded. `seedAosCaseQuestionnaire` merges
    them in at run time, appended last exactly as they were spread last here.

    What that costs: `FIELDS` and `SECTIONS` are the *declared* vocabulary, and
    the questionnaire that gets written is declared-plus-Part-9. Everything that
    reads these two — `assertVocabularyIsClosed`, `global-schema.test.ts`,
    `form-vocabulary.test.ts` — is asking about the declared half, which is the
    half a person wrote and the half that can drift.
  */
};

// ─── The questionnaire ───────────────────────────────────────────────────────

export const SECTIONS: {
  title: string;
  description: string;
  fields: string[];
}[] = [
  {
    title: "About you",
    description:
      "Your identity as it will appear on every form in the package. Please copy these from your passport rather than from memory — a name spelled two different ways across two forms is one of the most common reasons a filing is queried.",
    fields: [
      "beneficiary.family_name",
      "beneficiary.given_name",
      "beneficiary.middle_name",
      "beneficiary.other_names_used",
      "beneficiary.date_of_birth",
      "beneficiary.city_of_birth",
      "beneficiary.country_of_birth",
      "beneficiary.country_of_citizenship",
      "beneficiary.sex",
      "beneficiary.marital_status",
      "beneficiary.alien_number",
      "beneficiary.uscis_online_account_number",
      "beneficiary.ssn",
    ],
  },
  {
    title: "Where you live",
    description:
      "Five years of addresses, most recent first, and how we reach you. Tell us straight away if any of this changes while the case is open: a receipt or an interview notice sent to an old address is treated as delivered.",
    fields: [
      "beneficiary.address_history",
      "beneficiary.mailing_address.street",
      "beneficiary.mailing_address.unit",
      "beneficiary.mailing_address.city",
      "beneficiary.mailing_address.state",
      "beneficiary.mailing_address.zip",
      "beneficiary.daytime_phone",
      "beneficiary.email",
    ],
  },
  {
    title: "How you entered the United States",
    description:
      "Your last entry, and the status you hold now. Lawful entry and inspection is what makes adjustment inside the United States possible at all, so these answers decide the shape of the case.",
    fields: [
      "beneficiary.passport_number",
      "beneficiary.passport_country",
      "beneficiary.i94_number",
      "beneficiary.date_of_last_arrival",
      "beneficiary.place_of_last_arrival",
      "beneficiary.status_at_last_arrival",
      "beneficiary.current_immigration_status",
    ],
  },
  {
    title: "Your spouse",
    description:
      "The petitioning spouse — the person whose status makes you eligible. Whether they are a citizen or a permanent resident determines whether a visa number is available immediately or the case waits in a queue.",
    fields: [
      "petitioner.family_name",
      "petitioner.given_name",
      "petitioner.middle_name",
      "petitioner.date_of_birth",
      "petitioner.country_of_birth",
      "petitioner.citizenship_status",
      "petitioner.alien_number",
      "petitioner.ssn",
      "petitioner.daytime_phone",
      "petitioner.email",
      "petitioner.mailing_address.street",
      "petitioner.mailing_address.unit",
      "petitioner.mailing_address.in_care_of",
      "petitioner.mailing_address.city",
      "petitioner.mailing_address.state",
      "petitioner.mailing_address.zip",
      "petitioner.mailing_address.province",
      "petitioner.mailing_address.postal_code",
      "petitioner.mailing_address.country",
      "petitioner.address_history",
    ],
  },
  {
    title: "Your marriage",
    description:
      "When and where you married, and whether either of you was married before. Every earlier marriage must be shown to have legally ended before this one began, so please tell us about any of them even if they were brief or long ago.",
    fields: [
      "marriage.date",
      "marriage.city",
      "marriage.state",
      "marriage.country",
      "marriage.prior_marriages_beneficiary",
      "marriage.prior_marriages_petitioner",
    ],
  },
  {
    title: "Work and travel while you wait",
    description:
      "Two permissions that are filed alongside the main application and cost nothing extra when filed with it. Both take months to obtain on their own afterwards, which is why we ask now even if you are unsure.",
    fields: [
      "employment.eligibility_category",
      "travel.intends_to_travel",
      "travel.purpose",
      "travel.countries_intended",
    ],
  },
  {
    title: "Financial support",
    description:
      "Your spouse's undertaking to support you financially, which USCIS requires before granting residence. If their income does not reach the threshold, a second sponsor can join — better to know now than after a request for evidence.",
    fields: [
      "sponsor.household_size",
      "sponsor.annual_income",
      "sponsor.household_income",
      "sponsor.filed_tax_returns",
      "sponsor.tax_returns",
      "sponsor.has_joint_sponsor",
    ],
  },
  {
    title: "Medical examination",
    description:
      "It must be a USCIS-designated civil surgeon; an examination by your own doctor is not accepted. The doctor seals the completed form in an envelope — bring it to us unopened.",
    fields: [
      "medical.exam_completed",
      "medical.exam_date",
      "medical.civil_surgeon_name",
    ],
  },
  {
    title: "Your family",
    description:
      "Your parents and your children. USCIS asks for both regardless of where they live or whether they are part of this application, and a child left off is one of the things most likely to be noticed at interview.",
    fields: ["family.parents", "family.has_children", "family.children"],
  },
  {
    title: "Earlier marriages",
    description:
      "Every marriage either of you has had before this one. Each must be shown to have legally ended before this marriage began — that is what makes this marriage, and therefore this petition, valid.",
    fields: ["marriage.times_married", "marriage.prior_spouses"],
  },
  {
    title: "Work and school",
    description:
      'Five years, most recent first. Gaps matter more than jobs do: USCIS reads an unexplained gap as time you have not accounted for, and "unemployed, supported by my spouse" is a complete and perfectly ordinary answer.',
    fields: ["employment.history"],
  },
  {
    title: "Earlier immigration applications",
    description:
      "Anything you have filed before, anywhere, and how it ended. A refusal years ago is not usually a problem; a refusal we did not know about is.",
    fields: [
      "immigration.applied_immigrant_visa_before",
      "immigration.consulate_city",
      "immigration.consulate_country",
      "immigration.decision",
      "immigration.decision_date",
      "immigration.applied_for_residence_before",
      "immigration.lpr_rescinded",
    ],
  },
  {
    title: "Your description",
    description:
      "The physical details that go on the application and on your biometrics appointment. USCIS asks these of everyone.",
    fields: [
      "biographic.ethnicity",
      "biographic.race",
      "biographic.height_feet",
      "biographic.height_inches",
      "biographic.weight_lbs",
      "biographic.eye_color",
      "biographic.hair_color",
    ],
  },
  /*
    The eligibility and inadmissibility sections are appended by the seed, not
    listed here — see the note at the end of `FIELDS`. They stay last for the
    reason they always were: they are the longest part of the questionnaire and
    the least pleasant, and a client who has already told us their name and
    their address is a client who will finish.
  */
];

/**
 * A branch, as this file declares one.
 *
 * Written in field keys because everything else here is, and because a rule
 * naming question ids would have to be rewritten every time the bank is
 * reseeded. The seed resolves them to ids at the end, once every question
 * exists.
 */
type RuleDef = {
  /** The field key whose answer decides. */
  when: string;
  /** How to test it. */
  is: LogicCondition;
  /** Field keys shown *only* when the condition holds. */
  show?: string[];
  /** Field keys that become required when it holds. */
  require?: string[];
};

/** The shape nine rules in ten want. */
const yes: LogicCondition = { operator: "equals", value: "yes" };

/**
 * Every branch on the adjustment questionnaire.
 *
 * ─── Why a branch is worth the trouble ──────────────────────────────────────
 *
 * A client who has never been married before does not have an ex-spouse, and
 * asking them for one is not merely noise — it is the difference between a form
 * they finish and a form they abandon. This questionnaire asks 204 questions;
 * the branches below are what keep a straightforward case from seeing most of
 * them.
 *
 * ─── The rule that makes it safe ────────────────────────────────────────────
 *
 * A hidden answer is a withdrawn answer. Saying yes, naming an ex-spouse and
 * then changing to no leaves a row in the table, and nothing downstream would
 * ever ask why — `populateCaseForms` matches on field key and would print the
 * name on the I-130. Submission clears them and population skips them; both
 * read `lib/questionnaire/logic.ts`, which is also what the client's browser
 * evaluates as they type.
 */
export const RULES: RuleDef[] = [
  // ── Travel while the application is pending ───────────────────────────────
  {
    when: "travel.intends_to_travel",
    is: yes,
    show: ["travel.purpose", "travel.countries_intended"],
    require: ["travel.purpose"],
  },

  // ── Children ──────────────────────────────────────────────────────────────
  {
    when: "family.has_children",
    is: yes,
    show: ["family.children"],
    require: ["family.children"],
  },

  // ── Earlier marriages ─────────────────────────────────────────────────────
  //
  // Keyed on the count rather than on a yes/no, because the count is what the
  // I-485 actually prints: anything above one means there is a history to give.
  {
    when: "marriage.times_married",
    is: { operator: "not_equals", value: "1" },
    show: ["marriage.prior_spouses"],
  },

  // ── The medical examination ───────────────────────────────────────────────
  //
  // Both halves or neither: a civil surgeon's name with no date is not an
  // examination that happened.
  {
    when: "medical.exam_completed",
    is: yes,
    show: ["medical.exam_date", "medical.civil_surgeon_name"],
    require: ["medical.exam_date"],
  },

  // ── An earlier immigrant visa application ─────────────────────────────────
  {
    when: "immigration.applied_immigrant_visa_before",
    is: yes,
    show: [
      "immigration.consulate_city",
      "immigration.consulate_country",
      "immigration.decision",
      "immigration.decision_date",
    ],
    require: ["immigration.decision"],
  },

  // ── The sponsor's tax returns ─────────────────────────────────────────────
  //
  // Asked only of a sponsor who filed. One who did not has an exemption to
  // claim instead, and three empty year boxes are not how they claim it.
  {
    when: "sponsor.filed_tax_returns",
    is: yes,
    show: ["sponsor.tax_returns"],
    require: ["sponsor.tax_returns"],
  },
];

/**
 * Every field key a question asks is one this file declares.
 *
 * Checked rather than trusted, because a mismatch does not throw at runtime —
 * it quietly asks a question whose answer reaches no form. Exported so
 * `__tests__/unit/workflow/form-vocabulary.test.ts` runs it without a database,
 * which is what makes a typo a failing test rather than a field that is
 * mysteriously blank in production. Same reasoning as `UNBACKED_ANCHORS` and
 * `anchor-coverage.test.ts`.
 *
 * ─── Why there is no check in the other direction ───────────────────────────
 *
 * There used to be one: a `FORMS` table in this file listed which of these keys
 * each form printed, and a declared key that no form printed was an error. That
 * table is gone. A form's fields now come from its extracted JSON and nothing
 * else, so "which forms print `beneficiary.date_of_birth`" is no longer written
 * down here — it is the set of PDF boxes somebody has pointed that key at, in
 * the CRM, which is a row in `form_pdf_field_mappings` and cannot be known
 * without a database.
 *
 * The equivalent check is therefore the seed's own report: `seed-form-pdf-
 * catalogue` names every curated key still standing unmapped. That list is the
 * work outstanding, and it shrinks as boxes get claimed.
 */
export function assertVocabularyIsClosed() {
  const declared = new Set(Object.keys(FIELDS));
  const used = new Set<string>();

  for (const section of SECTIONS) for (const f of section.fields) used.add(f);

  const undeclared = [...used].filter((f) => !declared.has(f));
  if (undeclared.length) {
    throw new Error(
      `Field keys used but not declared in FIELDS: ${undeclared.join(", ")}`,
    );
  }
}

const AOS_CASE_TYPE_NAMES = [
  "family-based adjustment of status",
  "adjustment of status",
  "family-based adjustment of status (i-130 + i-485)",
  "i-485 — adjustment of status (family-based)",
];

export async function seedAosCaseQuestionnaire() {
  assertVocabularyIsClosed();

  /*
    Part 9, read out of the I-485's catalogue and appended.

    The prerequisite this seed gained when the forms left the repo: somebody has
    to have uploaded the I-485's blank and imported it, in the CRM, before these
    117 questions exist to be asked. That is an operator action rather than
    another seed, so it cannot be chained — only reported.

    Reported loudly, because the failure is silent otherwise. The questionnaire
    seeds fine without them, the client finishes it, and every ground of
    inadmissibility goes unasked on a form the client then signs.
  */
  const security = await securityQuestions();
  if (security.sections.length === 0) {
     
    console.warn(
      `\nNo Part 9 questions were found for ${SECURITY_FORM}, so the questionnaire is being seeded WITHOUT the eligibility and inadmissibility questions.`,
      `\nUpload the ${SECURITY_FORM} blank at /platform → Forms → ${SECURITY_FORM} → Versions & PDF, import it, then re-run this seed.`,
    );
  }

  const fields: Record<string, FieldDef> = { ...FIELDS, ...security.fields };
  const sections = [...SECTIONS, ...security.sections];

  // ── The case questionnaire, one per matching case type ──────────────────
  const caseTypes = await db.select().from(practiceAreaCaseTypes);
  const matches = caseTypes.filter((ct) =>
    AOS_CASE_TYPE_NAMES.includes(ct.name.trim().toLowerCase()),
  );

  if (matches.length === 0) {
     
    console.warn(
      `No case type matched ${AOS_CASE_TYPE_NAMES.join(" / ")}, so no questionnaire was seeded. Check the case-type taxonomy.`,
    );
    return { questionnaires: 0 };
  }

  let questionnaireCount = 0;
  let ruleCount = 0;

  for (const caseType of matches) {
    const [questionnaire] = await db
      .insert(questionnaires)
      .values({
        caseTypeId: caseType.id,
        stage: "case",
        title: `${caseType.name} — Case Questionnaire`,
        description:
          "Everything needed to prepare this matter's filing package. Each answer fills every form that asks for it, so nothing here is asked twice.",
      })
      .onConflictDoUpdate({
        target: [questionnaires.caseTypeId, questionnaires.stage],
        set: { updatedAt: new Date() },
      })
      .returning();

    for (const [sectionIndex, section] of sections.entries()) {
      const [existingSection] = await db
        .select()
        .from(questionnaireSections)
        .where(
          and(
            eq(questionnaireSections.questionnaireId, questionnaire.id),
            eq(questionnaireSections.scope, "system"),
            eq(questionnaireSections.title, section.title),
          ),
        )
        .limit(1);

      const sectionRow =
        existingSection ??
        (
          await db
            .insert(questionnaireSections)
            .values({
              questionnaireId: questionnaire.id,
              scope: "system",
              title: section.title,
              description: section.description,
              orderIndex: sectionIndex,
            })
            .returning()
        )[0];

      if (existingSection) {
        await db
          .update(questionnaireSections)
          .set({
            description: section.description,
            orderIndex: sectionIndex,
            updatedAt: new Date(),
          })
          .where(eq(questionnaireSections.id, sectionRow.id));
      }

      for (const [questionIndex, fieldKey] of section.fields.entries()) {
        const def = fields[fieldKey];

        // Keyed on `fieldKey` rather than on label, so re-wording a question
        // updates it in place instead of creating a second one — and every
        // answer already given stays attached.
        const [existingQuestion] = await db
          .select()
          .from(questionnaireQuestions)
          .where(
            and(
              eq(questionnaireQuestions.questionnaireId, questionnaire.id),
              eq(questionnaireQuestions.fieldKey, fieldKey),
            ),
          )
          .limit(1);

        const values = {
          questionnaireId: questionnaire.id,
          sectionId: sectionRow.id,
          scope: "system" as const,
          fieldKey,
          label: def.question,
          description: def.help ?? null,
          type: def.type,
          orderIndex: questionIndex,
          isRequired: def.required ?? false,
          config: (def.config ?? {}) as Record<string, unknown>,
        };

        if (existingQuestion) {
          await db
            .update(questionnaireQuestions)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(questionnaireQuestions.id, existingQuestion.id));
        } else {
          await db.insert(questionnaireQuestions).values(values);
        }
      }
    }

    /*
      The branches, written last because they point at questions by id and every
      question has just been written.

      Replaced wholesale rather than upserted. A rule has no natural key — it is
      a source, a target, a condition and an action, any of which can change —
      so "the same rule, edited" is not a thing this seed can recognise. What it
      can guarantee is that the rules on a questionnaire are exactly the rules
      this file declares, which is the property that matters: a branch removed
      from `RULES` must stop applying, and an upsert would leave it in place
      forever, hiding a question nobody could find the reason for.
    */
    await db
      .delete(questionnaireLogicRules)
      .where(
        and(
          eq(questionnaireLogicRules.questionnaireId, questionnaire.id),
          eq(questionnaireLogicRules.scope, "system"),
        ),
      );

    const questionIdByKey = new Map(
      (
        await db
          .select({
            id: questionnaireQuestions.id,
            fieldKey: questionnaireQuestions.fieldKey,
          })
          .from(questionnaireQuestions)
          .where(eq(questionnaireQuestions.questionnaireId, questionnaire.id))
      )
        .filter((row): row is { id: string; fieldKey: string } =>
          Boolean(row.fieldKey),
        )
        .map((row) => [row.fieldKey, row.id] as const),
    );

    let priority = 0;
    for (const rule of RULES) {
      const sourceQuestionId = questionIdByKey.get(rule.when);
      // A rule whose source is not on this questionnaire is skipped rather than
      // thrown on: `RULES` is written against the whole vocabulary, and a case
      // type could one day be seeded with a subset of it.
      if (!sourceQuestionId) continue;

      const targets: [string, string[]][] = [
        ["show_question", rule.show ?? []],
        ["require_question", rule.require ?? []],
      ];

      for (const [actionType, keys] of targets) {
        for (const key of keys) {
          const targetQuestionId = questionIdByKey.get(key);
          if (!targetQuestionId) continue;

          await db.insert(questionnaireLogicRules).values({
            questionnaireId: questionnaire.id,
            scope: "system",
            sourceQuestionId,
            targetQuestionId,
            condition: rule.is as unknown as Record<string, unknown>,
            actionType: actionType as "show_question" | "require_question",
            priority: priority++,
          });
          ruleCount++;
        }
      }
    }

    questionnaireCount++;
  }

  return { questionnaires: questionnaireCount, rules: ruleCount };
}
