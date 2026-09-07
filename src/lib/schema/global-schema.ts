import { z } from "zod";

import {
  choice,
  date,
  dropdown,
  email,
  list,
  longText,
  multiChoice,
  number,
  phone,
  text,
  yesNo,
} from "./nodes";

/**
 * ─── One vocabulary for the whole system ─────────────────────────────────────
 *
 * Everything this system knows about an immigration matter, declared once. A
 * questionnaire question asks for a node; a form field prints one; population
 * carries the answer across because both name the same node.
 *
 * That join used to be a *string* — `fieldKey` on both sides, matched exactly,
 * with nothing checking that the two spellings agreed. A key one character off
 * matched no box, filled nothing, and reported nothing: the form printed blank,
 * weeks later, inside a filing. This file is that string promoted to a
 * declaration, and `schema_nodes` is it promoted to a foreign key.
 *
 * ── What is deliberately not in here ──
 *
 * **Form-local names.** Extraction names every box it finds — `i485.pt9.10_yes_no`,
 * `i130.pt2.2_uscis_online_account_number` — and most of them are asked by
 * exactly one form. Those stay form-local and bind to no node, which is why
 * `schema_node_id` is nullable on both sides. The 117 Part 9 eligibility
 * questions on the I-485 are the large case: real facts about a person, but
 * nothing else asks them and nothing else prints them.
 *
 * **Requiredness.** A node is a datum, not a demand. Whether an answer is
 * required belongs to the question that asks for it (`isRequired`) and to the
 * logic rules that can make it conditional — see `lib/questionnaire/logic.ts`.
 * Declaring it here as well would be a second source that disagrees.
 *
 * **The wording of the question, and its help text.** Those stay in
 * `aos-case-questionnaire.seed.ts` for now; `global-schema.test.ts` asserts
 * that the labels, types and options here match what the seed declares, so the
 * two cannot drift while both exist.
 *
 * ── A note on the repetition below ──
 *
 * The three address histories and the three lists of people look shareable and
 * are not: `beneficiary.address_history` carries an `in_care_of` the
 * petitioner's does not, `employment.history` wraps the same eight parts in an
 * employer and a job title, and the labels differ by whose address it is
 * ("Lived here from" against "From"). Factoring them into a common shape would
 * disturb the field *order* — which is the order a client answers them in — and
 * would trade nine readable lines for a lookup a reviewer has to resolve in
 * their head. The duplication here is data, not logic.
 */

const US_STATES = [
  "AA", "AE", "AK", "AL", "AP", "AR", "AS", "AZ", "CA", "CO", "CT", "DC", "DE",
  "FL", "FM", "GA", "GU", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA",
  "MD", "ME", "MH", "MI", "MN", "MO", "MP", "MS", "MT", "NC", "ND", "NE", "NH",
  "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "PR", "PW", "RI", "SC", "SD",
  "TN", "TX", "UT", "VA", "VI", "VT", "WA", "WI", "WV", "WY",
] as const;

/**
 * The applicant. On a family-based adjustment this is the person the
 * petitioner is filing for, and their name prints on all six forms.
 */
const Beneficiary = z.object({
  family_name: text("Family Name (Last Name)"),
  given_name: text("Given Name (First Name)"),
  middle_name: text("Middle Name"),
  other_names_used: longText("Other Names Used"),
  date_of_birth: date("Date of Birth (mm/dd/yyyy)"),
  city_of_birth: text("City/Town/Village of Birth"),
  country_of_birth: text("Country of Birth"),
  country_of_citizenship: text("Country of Citizenship or Nationality"),
  sex: choice("Sex", ["Male", "Female"]),
  alien_number: text("Alien Registration Number (A-Number)"),
  uscis_online_account_number: text("USCIS Online Account Number"),
  ssn: text("U.S. Social Security Number"),
  /**
   * The I-485's six options, verbatim. `canonicalAnswer` compares lowercased
   * and whitespace-collapsed and nothing more, so "Legally Separated" here and
   * the I-130's "Separated" are different answers — which is why the I-130 and
   * I-765 marital boxes are deliberately left unwired.
   */
  marital_status: choice("Current Marital Status", [
    "Single, Never Married",
    "Married",
    "Divorced",
    "Widowed",
    "Legally Separated",
    "Marriage Annulled",
  ]),
  address_history: list(
    "Physical Address",
    z.object({
      street: text("Street number and name"),
      unit_number: text("Apartment, suite or floor number"),
      in_care_of: text("In care of name, if any"),
      city: text("City or town"),
      state: dropdown("State", US_STATES),
      zip: text("ZIP code"),
      province: text("Province, if outside the United States"),
      postal_code: text("Postal code, if outside the United States"),
      country: text("Country"),
      date_from: date("Lived here from"),
      date_to: date("Lived here until"),
    }),
  ),
  mailing_address: z.object({
    street: text("Street Number and Name"),
    unit: text("Apt./Ste./Flr."),
    city: text("City or Town"),
    state: dropdown("State", US_STATES),
    zip: text("ZIP Code"),
  }),
  daytime_phone: phone("Daytime Telephone Number"),
  email: email("Email Address"),
  passport_number: text("Passport Number"),
  passport_country: text("Country of Issuance for Passport"),
  i94_number: text("Form I-94 Arrival-Departure Record Number"),
  date_of_last_arrival: date("Date of Last Arrival (mm/dd/yyyy)"),
  place_of_last_arrival: text("Place of Last Arrival"),
  status_at_last_arrival: text("Status at Last Arrival"),
  current_immigration_status: text("Current Immigration Status"),
});

/** The U.S. citizen or permanent resident filing on the beneficiary's behalf. */
const Petitioner = z.object({
  family_name: text("Petitioner's Family Name (Last Name)"),
  given_name: text("Petitioner's Given Name (First Name)"),
  middle_name: text("Petitioner's Middle Name"),
  date_of_birth: date("Petitioner's Date of Birth (mm/dd/yyyy)"),
  country_of_birth: text("Petitioner's Country of Birth"),
  citizenship_status: choice("Petitioner's Status", [
    "U.S. citizen",
    "Lawful permanent resident",
  ]),
  alien_number: text("Petitioner's A-Number"),
  ssn: text("Petitioner's U.S. Social Security Number"),
  daytime_phone: phone("Petitioner's Daytime Telephone Number"),
  email: email("Petitioner's Email Address"),
  mailing_address: z.object({
    street: text("Street Number and Name"),
    unit: text("Apt./Ste./Flr."),
    in_care_of: text("In Care Of Name"),
    city: text("City or Town"),
    state: dropdown("State", US_STATES),
    zip: text("ZIP Code"),
    province: text("Province"),
    postal_code: text("Postal Code"),
    country: text("Country"),
  }),
  address_history: list(
    "Physical Address",
    z.object({
      street: text("Street number and name"),
      unit_number: text("Apartment, suite or floor number"),
      city: text("City or town"),
      state: dropdown("State", US_STATES),
      zip: text("ZIP code"),
      province: text("Province, if outside the United States"),
      postal_code: text("Postal code, if outside the United States"),
      country: text("Country"),
      date_from: date("Lived here from"),
      date_to: date("Lived here until"),
    }),
  ),
});

/** The marriage the petition rests on, and every marriage before it. */
const Marriage = z.object({
  date: date("Date of Marriage (mm/dd/yyyy)"),
  city: text("City or Town of Marriage"),
  state: text("State or Province of Marriage"),
  country: text("Country of Marriage"),
  /**
   * Yes/no, and deliberately not wired to a box: the I-130 box asks *how many
   * times*, and printing "Yes" into it is a wrong answer that looks complete.
   * `marriage.times_married` is the datum that box wants.
   */
  prior_marriages_beneficiary: yesNo("Applicant's Prior Marriages"),
  prior_marriages_petitioner: yesNo("Petitioner's Prior Marriages"),
  times_married: number("Number of Marriages"),
  prior_spouses: list(
    "Prior Spouse",
    z.object({
      family_name: text("Their last name before the marriage"),
      given_name: text("Their first name"),
      middle_name: text("Their middle name"),
      date_of_birth: date("Their date of birth"),
      country_of_birth: text("Their country of birth"),
      country_of_citizenship: text("Their country of citizenship"),
      marriage_date: date("Date you married"),
      marriage_city: text("City or town where you married"),
      marriage_state: text("State or province where you married"),
      marriage_country: text("Country where you married"),
      ended_date: date("Date the marriage legally ended"),
      ended_city: text("City or town where it ended"),
      ended_state: text("State or province where it ended"),
      ended_country: text("Country where it ended"),
      how_ended: choice("How it ended", [
        "Divorced",
        "Spouse Deceased",
        "Annulled",
        "Other (Explain)",
      ]),
      how_ended_other: longText("If other, please explain"),
    }),
  ),
});

/** Parents and children — asked once, printed across the package. */
const Family = z.object({
  parents: list(
    "Parent",
    z.object({
      family_name: text("Last name (family name)"),
      given_name: text("First name (given name)"),
      middle_name: text("Middle name"),
      birth_family_name: text("Last name at birth, if different"),
      birth_given_name: text("First name at birth, if different"),
      birth_middle_name: text("Middle name at birth, if different"),
      date_of_birth: date("Date of birth"),
      country_of_birth: text("Country of birth"),
    }),
  ),
  has_children: yesNo("Do you have any living children?"),
  children: list(
    "Child",
    z.object({
      family_name: text("Last name (family name)"),
      given_name: text("First name (given name)"),
      middle_name: text("Middle name"),
      alien_number: text("Alien Registration Number (A-Number), if any"),
      date_of_birth: date("Date of birth"),
      country_of_birth: text("Country of birth"),
      relationship: text("Relationship to you"),
      applying_separately: yesNo(
        "Is this child also applying now, on their own Form I-485?",
      ),
    }),
  ),
});

/** Part 5 of the I-485: the description that goes on the green card. */
const Biographic = z.object({
  ethnicity: choice("Ethnicity", ["Hispanic or Latino", "Not Hispanic or Latino"]),
  race: multiChoice("Race", [
    "Asian",
    "White",
    "Black or African American",
    "American Indian or Alaska Native",
    "Native Hawaiian or Other Pacific Islander",
  ]),
  height_feet: dropdown("Height (Feet)", ["2", "3", "4", "5", "6", "7", "8"]),
  height_inches: dropdown("Height (Inches)", [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11",
  ]),
  weight_lbs: number("Weight (Pounds)"),
  eye_color: choice("Eye Color", [
    "Blue", "Black", "Brown", "Gray", "Green", "Hazel", "Maroon", "Pink",
    "Unknown / Other",
  ]),
  hair_color: choice("Hair Color", [
    "Bald (No hair)", "Black", "Blond", "Brown", "Gray", "Red", "Sandy",
    "White", "Unknown / Other",
  ]),
});

/** What has been asked of USCIS before, and how it went. */
const Immigration = z.object({
  applied_immigrant_visa_before: yesNo(
    "Have you ever applied for an immigrant visa at a U.S. embassy or consulate abroad?",
  ),
  consulate_city: text("City or Town"),
  consulate_country: text("Country"),
  decision: text("Decision"),
  decision_date: date("Date of Decision"),
  applied_for_residence_before: yesNo(
    "Have you previously applied for permanent residence while inside the United States?",
  ),
  lpr_rescinded: yesNo(
    "Have you ever held permanent resident status that was later taken away?",
  ),
});

const Employment = z.object({
  /**
   * Yes/no, and not wired: the I-765 box wants a category code like `(c)(9)`.
   * Printing "Yes" there is a wrong answer that looks answered.
   */
  eligibility_category: yesNo("Eligibility Category"),
  history: list(
    "Employment History",
    z.object({
      employer_name: text("Employer or school name"),
      occupation: text("Your job title or course"),
      street: text("Street number and name"),
      unit_number: text("Apartment, suite or floor number"),
      city: text("City or town"),
      state: dropdown("State", US_STATES),
      zip: text("ZIP code"),
      province: text("Province, if outside the United States"),
      postal_code: text("Postal code, if outside the United States"),
      country: text("Country"),
      date_from: date("From"),
      date_to: date("Until"),
      support_source: text("If unemployed or retired, what did you live on?"),
    }),
  ),
});

/** The I-864: who is promising to support the beneficiary, and on what income. */
const Sponsor = z.object({
  household_size: number("Sponsor's Household Size"),
  annual_income: number("Sponsor's Current Annual Household Income"),
  household_income: number("Current Annual Household Income"),
  has_joint_sponsor: yesNo("Joint Sponsor"),
  filed_tax_returns: yesNo(
    "Has your spouse filed a federal income tax return for each of the last three years?",
  ),
  tax_returns: list(
    "Federal Income Tax Return",
    z.object({
      tax_year: text("Tax year"),
      total_income: number("Total income for that year"),
    }),
  ),
});

/**
 * The I-693, which a USCIS-designated civil surgeon completes and seals. We
 * never print that form — see `provided_by` — so these are the facts the firm
 * records about it: that it happened, when, and who signed it.
 */
const Medical = z.object({
  exam_completed: yesNo("Have you had your immigration medical examination yet?"),
  exam_date: date("Date of Examination (mm/dd/yyyy)"),
  civil_surgeon_name: text("Civil Surgeon's Name"),
});

/** The I-131: advance parole, for someone who needs to leave and come back. */
const Travel = z.object({
  intends_to_travel: yesNo("Application Type"),
  purpose: longText("Purpose of Trip"),
  countries_intended: text("Countries to be Visited"),
});

export const GlobalImmigrationSchema = z.object({
  beneficiary: Beneficiary,
  petitioner: Petitioner,
  marriage: Marriage,
  family: Family,
  biographic: Biographic,
  immigration: Immigration,
  employment: Employment,
  sponsor: Sponsor,
  medical: Medical,
  travel: Travel,
});

/** Everything that can be known about a matter. */
export type CaseDocument = z.infer<typeof GlobalImmigrationSchema>;
