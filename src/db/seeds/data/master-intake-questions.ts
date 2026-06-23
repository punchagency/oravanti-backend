/**
 * Master Client Intake Questionnaire — structured transcription of
 * Oravanti_Master_Intake_Questionnaire.pdf.
 *
 * Organised as in the PDF: Practice Specialty → Filing Category → Matter Subtype.
 * Each subtype lists its question labels (the input TYPE is inferred from the label
 * text by the seed) and its "Attach:" documents (modelled as file_upload questions
 * in a "Required Documents" section).
 *
 * `caseTypes` holds the candidate DB case-type names (from the practice-area
 * taxonomy) this subtype maps to. The seed resolves them by normalised name and
 * logs any it cannot confidently match. This list is a faithful representative
 * subset — append more subtypes here as needed; the seed picks them up.
 */

export type MasterSubtype = {
  /** stable identifier for logging */
  key: string;
  /** PDF matter-subtype heading */
  name: string;
  questions: string[];
  documents?: string[];
  /** DB practiceAreaCaseTypes.name candidates this subtype maps to */
  caseTypes: string[];
};

export type MasterFilingCategory = {
  name: string;
  subtypes: MasterSubtype[];
};

export type MasterPracticeSpecialty = {
  name: string;
  categories: MasterFilingCategory[];
};

export const MASTER_INTAKE_QUESTIONNAIRE: MasterPracticeSpecialty[] = [
  {
    name: "Immigration Law",
    categories: [
      {
        name: "Family-Based Immigration",
        subtypes: [
          {
            key: "imm.fb.spouse-usc-lpr",
            name: "Spouse of U.S. Citizen / LPR (I-130 / I-485 / IR-1, CR-1)",
            questions: [
              "Petitioner's full legal name",
              "Petitioner's citizenship/status (USC or LPR)",
              "Beneficiary (spouse) full legal name",
              "Date of marriage",
              "Place of marriage",
              "Is this either spouse's first marriage?",
              "If not, how/when did prior marriage(s) end?",
              "Is the beneficiary currently in the U.S.?",
              "If in the U.S., current immigration status and I-94 expiration",
              "Briefly describe how you and your spouse met and your relationship history.",
            ],
            documents: [
              "Marriage certificate",
              "Proof of termination of prior marriages",
              "Passport biographic pages",
              "Two passport-style photos",
            ],
            caseTypes: [
              "I-130 — Petition for Alien Relative",
              "Spouse of USC (IR-1 / CR-1)",
              "I-485 — Adjustment of Status (Family-Based)",
            ],
          },
          {
            key: "imm.fb.parent-usc",
            name: "Parent of U.S. Citizen (I-130 / I-485, IR-5)",
            questions: [
              "Petitioning child's full legal name and date of birth",
              "Beneficiary parent's full legal name",
              "Is the petitioner at least 21 years old?",
              "Parent's current country of residence",
            ],
            documents: [
              "Petitioner's birth certificate",
              "Proof of petitioner's U.S. citizenship",
              "Parent-child relationship evidence",
            ],
            caseTypes: ["I-130 — Petition for Alien Relative"],
          },
          {
            key: "imm.fb.aos",
            name: "Adjustment of Status — Family-Based (I-485)",
            questions: [
              "Applicant's full legal name",
              "Underlying petition receipt number (I-130)",
              "Date of last entry to U.S.",
              "Port of entry",
              "Current immigration status / visa classification",
              "Any prior denials, removal proceedings, or unlawful presence?",
            ],
            documents: [
              "I-94 record",
              "Passport biographic page",
              "Medical exam (I-693)",
              "Affidavit of support documents",
            ],
            caseTypes: ["I-485 — Adjustment of Status (Family-Based)"],
          },
        ],
      },
      {
        name: "Employment-Based Immigration",
        subtypes: [
          {
            key: "imm.eb.eb1a",
            name: "Extraordinary Ability — EB-1A (I-140 Self-Petition)",
            questions: [
              "Beneficiary's full legal name and field of expertise",
              "List major awards, publications, or recognitions in your field.",
              "Do you have a U.S. employer sponsor, or is this self-petitioned?",
            ],
            documents: [
              "CV",
              "Evidence of at least 3 of the 10 EB-1A criteria",
              "Letters of recommendation",
            ],
            caseTypes: ["EB-1A — Extraordinary Ability"],
          },
          {
            key: "imm.eb.eb1b",
            name: "Outstanding Professor/Researcher — EB-1B (I-140)",
            questions: [
              "Sponsoring institution/employer's legal name",
              "Beneficiary's field of research",
              "Years of experience in the field",
            ],
            caseTypes: ["EB-1B — Outstanding Professor or Researcher"],
          },
          {
            key: "imm.eb.eb1c",
            name: "Multinational Executive/Manager — EB-1C (I-140)",
            questions: [
              "U.S. petitioning company's legal name",
              "Foreign affiliated/parent company name",
              "Beneficiary's title abroad and proposed U.S. title",
              "Has beneficiary worked abroad for the company for 1+ of the past 3 years?",
            ],
            caseTypes: ["EB-1C — Multinational Manager / Executive"],
          },
          {
            key: "imm.eb.niw",
            name: "National Interest Waiver — EB-2 NIW (I-140)",
            questions: [
              "Beneficiary's full legal name and field",
              "Describe the proposed endeavor and its national importance.",
              "Highest degree held and institution",
            ],
            caseTypes: [
              "EB-2 NIW — National Interest Waiver (I-140 Self-Petition)",
            ],
          },
          {
            key: "imm.eb.h1b",
            name: "H-1B Specialty Occupation Worker (I-129)",
            questions: [
              "Sponsoring employer's legal name",
              "Beneficiary's full legal name",
              "Job title, duties, and offered wage",
              "Was the beneficiary selected in the H-1B cap registration lottery?",
              "Beneficiary's highest degree and field of study",
            ],
            documents: [
              "Beneficiary's diploma/transcripts",
              "Resume",
              "Employer's LCA",
            ],
            caseTypes: ["H-1B Specialty Occupation Worker (I-129)"],
          },
        ],
      },
      {
        name: "Humanitarian Relief",
        subtypes: [
          {
            key: "imm.hr.vawa",
            name: "VAWA Self-Petition — Spouse/Child/Parent of Abuser (I-360)",
            questions: [
              "Self-petitioner's full legal name",
              "Abuser's full legal name and immigration status (USC or LPR)",
              "Relationship to abuser (spouse, child, or parent)",
              "Briefly describe the abuse experienced (physical, emotional, or extreme cruelty).",
              "Have you reported the abuse to police or sought a protective order?",
            ],
            documents: [
              "Police reports",
              "Protective orders",
              "Medical records",
              "Supporting affidavits",
            ],
            caseTypes: [
              "I-360 — VAWA Self-Petition (Spouse / Child / Parent of Abuser)",
            ],
          },
          {
            key: "imm.hr.asylum-affirmative",
            name: "Asylum — Affirmative (I-589)",
            questions: [
              "Applicant's full legal name and country of nationality",
              "Date of last entry to U.S.",
              "One-year filing deadline date",
              "Briefly describe the persecution experienced or feared, and on what basis (race, religion, nationality, political opinion, or social group).",
              "Family members in the U.S. to include on the application",
            ],
            documents: [
              "Country condition evidence",
              "Identity documents",
              "Any police/medical/news reports corroborating the claim",
            ],
            caseTypes: ["Asylum — Affirmative (I-589)"],
          },
        ],
      },
      {
        name: "Naturalization & Cross-Cutting Matters",
        subtypes: [
          {
            key: "imm.nat.n400",
            name: "Naturalization (N-400)",
            questions: [
              "Applicant's full legal name and green card number",
              "Date became a permanent resident",
              "Have you been outside the U.S. for 6+ months on any single trip?",
              "Have you ever been arrested, cited, or detained by any law enforcement officer?",
            ],
            documents: [
              "Green card copy",
              "Travel history for the past 5 years",
              "Tax returns (last 3-5 years)",
            ],
            caseTypes: ["N-400 — Application for Naturalization", "Naturalization (N-400)"],
          },
        ],
      },
    ],
  },
  {
    name: "Family Law",
    categories: [
      {
        name: "Divorce / Dissolution of Marriage",
        subtypes: [
          {
            key: "fam.div.uncontested",
            name: "Uncontested Divorce (No Children, No Real Property)",
            questions: [
              "Petitioner's full legal name",
              "Respondent's full legal name",
              "Date of marriage",
              "Date of separation",
              "Have both parties signed a marital settlement agreement?",
            ],
            documents: ["Marriage certificate", "Signed settlement agreement (if any)"],
            caseTypes: [
              "Uncontested / Simplified Dissolution",
              "Uncontested Divorce",
            ],
          },
          {
            key: "fam.div.contested",
            name: "Contested Divorce",
            questions: [
              "Petitioner's full legal name",
              "Respondent's full legal name",
              "Issues in dispute (custody, support, property, debt)",
              "Briefly describe the primary points of disagreement.",
              "Has the respondent been served with the petition?",
            ],
            caseTypes: ["Contested Divorce Proceedings", "Contested Divorce"],
          },
        ],
      },
      {
        name: "Child Custody, Support & Parentage",
        subtypes: [
          {
            key: "fam.cust.timesharing",
            name: "Time-Sharing / Parenting Plan (Custody)",
            questions: [
              "Children's full names and dates of birth",
              "Current living/custody arrangement",
              "Proposed time-sharing schedule",
              "Are there any concerns about the other parent's fitness or safety risks?",
            ],
            caseTypes: ["Time-Sharing / Parenting Plan", "Child Custody"],
          },
          {
            key: "fam.cust.childsupport",
            name: "Child Support — Establishment / Modification",
            questions: [
              "Requesting party's gross monthly income",
              "Other party's gross monthly income",
              "Number of overnights each parent has with the children",
              "Childcare, health insurance, and extracurricular costs",
            ],
            documents: [
              "Florida Child Support Guidelines Worksheet",
              "Recent pay stubs",
              "Daycare/insurance statements",
            ],
            caseTypes: ["Child Support Establishment / Modification", "Child Support"],
          },
        ],
      },
    ],
  },
  {
    name: "Criminal Law",
    categories: [
      {
        name: "Misdemeanor Defense",
        subtypes: [
          {
            key: "crim.misd.charges",
            name: "Misdemeanor Charges (DUI, Petit Theft, Simple Battery, etc.)",
            questions: [
              "Defendant's full legal name",
              "Charge(s) and statute number",
              "Arrest date",
              "Case/citation number",
              "Next court date and division",
              "Was a breath, blood, or field sobriety test administered (if DUI)?",
            ],
            documents: ["Arrest report/citation", "Bond paperwork"],
            caseTypes: ["Misdemeanor Charges", "Misdemeanor Defense", "DUI Defense"],
          },
        ],
      },
      {
        name: "Felony Defense",
        subtypes: [
          {
            key: "crim.fel.charges",
            name: "Felony Charges (Drug, Theft, Violent, Sex Crimes)",
            questions: [
              "Defendant's full legal name",
              "Charge(s), degree of felony, and statute number",
              "Arrest date",
              "Case number",
              "Is the defendant currently in custody or out on bond?",
              "Next court date and division/judge",
              "Briefly describe the circumstances of the arrest from your perspective.",
            ],
            caseTypes: ["Felony Charges", "Felony Defense"],
          },
        ],
      },
    ],
  },
  {
    name: "Personal Injury Law",
    categories: [
      {
        name: "Vehicle Accidents",
        subtypes: [
          {
            key: "pi.veh.auto",
            name: "Auto Accident (Car, Motorcycle, Truck, Rideshare)",
            questions: [
              "Client's full legal name",
              "Date of accident",
              "Location of accident",
              "Other driver's name and insurance carrier (if known)",
              "Was a police report filed?",
              "Briefly describe how the accident happened.",
              "Injuries sustained",
              "Have you sought medical treatment? If so, where?",
            ],
            documents: [
              "Police report",
              "Photos of vehicles/scene",
              "Insurance card",
              "Medical records/bills to date",
            ],
            caseTypes: ["Auto Accident", "Motor Vehicle Accident", "Car Accident"],
          },
        ],
      },
      {
        name: "Premises Liability",
        subtypes: [
          {
            key: "pi.prem.slipfall",
            name: "Slip & Fall / Trip & Fall",
            questions: [
              "Client's full legal name",
              "Date of incident",
              "Location (business/property name)",
              "Describe the hazard that caused the fall (wet floor, uneven surface, etc.).",
              "Was an incident report completed at the location?",
              "Injuries sustained",
            ],
            documents: [
              "Photos of the hazard/scene",
              "Incident report",
              "Witness contact information",
            ],
            caseTypes: ["Slip & Fall", "Premises Liability"],
          },
        ],
      },
      {
        name: "Medical Malpractice",
        subtypes: [
          {
            key: "pi.medmal.negligence",
            name: "Medical Malpractice / Negligence",
            questions: [
              "Patient's full legal name",
              "Healthcare provider/facility name",
              "Date(s) of treatment",
              "Date harm was discovered",
              "Describe what happened and the resulting injury or harm.",
            ],
            documents: ["Relevant medical records, if available"],
            caseTypes: ["Medical Malpractice", "Medical Negligence"],
          },
        ],
      },
      {
        name: "Wrongful Death",
        subtypes: [
          {
            key: "pi.wd.claim",
            name: "Wrongful Death Claim",
            questions: [
              "Decedent's full legal name and date of death",
              "Personal representative's full legal name",
              "Surviving family members (spouse, children, parents)",
              "Describe the circumstances leading to the death.",
            ],
            documents: ["Death certificate", "Probate/estate documentation if available"],
            caseTypes: ["Wrongful Death Claim", "Wrongful Death"],
          },
        ],
      },
    ],
  },
  {
    name: "Business & Corporate Law",
    categories: [
      {
        name: "Entity Formation",
        subtypes: [
          {
            key: "biz.form.newentity",
            name: "New Business Entity Formation (LLC, Corporation, Partnership)",
            questions: [
              "Proposed business name",
              "Entity type desired (LLC, S-Corp, C-Corp, Partnership)",
              "Owners/members and ownership percentages",
              "Registered agent name and address",
              "Briefly describe the nature of the business.",
            ],
            caseTypes: ["New Business Entity Formation", "Business Formation", "Entity Formation"],
          },
        ],
      },
      {
        name: "Intellectual Property",
        subtypes: [
          {
            key: "biz.ip.trademark",
            name: "Trademark Application / Registration",
            questions: [
              "Mark/name to be registered",
              "Goods/services associated with the mark",
              "Is the mark currently in use in commerce?",
            ],
            caseTypes: ["Trademark Application / Registration", "Trademark Registration"],
          },
        ],
      },
    ],
  },
  {
    name: "Estate Planning Law",
    categories: [
      {
        name: "Core Estate Planning Documents",
        subtypes: [
          {
            key: "est.core.will",
            name: "Last Will and Testament",
            questions: [
              "Testator's full legal name",
              "Proposed executor/personal representative",
              "Beneficiaries and intended distributions",
              "Are there minor children requiring a guardian designation?",
            ],
            caseTypes: ["Last Will and Testament", "Will Drafting"],
          },
        ],
      },
      {
        name: "Trust Planning",
        subtypes: [
          {
            key: "est.trust.revocable",
            name: "Revocable Living Trust",
            questions: [
              "Grantor's full legal name",
              "Proposed trustee and successor trustee(s)",
              "Beneficiaries and intended distributions",
              "Major assets to be titled into the trust",
            ],
            caseTypes: ["Revocable Living Trust", "Living Trust"],
          },
        ],
      },
      {
        name: "Probate Administration",
        subtypes: [
          {
            key: "est.probate.formal",
            name: "Formal Probate Administration",
            questions: [
              "Decedent's full legal name and date of death",
              "Did the decedent leave a will?",
              "Proposed/named personal representative",
              "Approximate value and description of the estate's assets",
            ],
            documents: [
              "Death certificate",
              "Original will (if any)",
              "List of known assets and debts",
            ],
            caseTypes: ["Formal Probate Administration", "Probate Administration"],
          },
        ],
      },
    ],
  },
  {
    name: "Employment Law",
    categories: [
      {
        name: "Discrimination",
        subtypes: [
          {
            key: "emp.disc.workplace",
            name: "Workplace Discrimination (Title VII, ADA, ADEA)",
            questions: [
              "Employee's full legal name",
              "Employer's name",
              "Protected class basis (race, sex, age, disability, religion, national origin)",
              "Describe the discriminatory conduct and dates it occurred.",
              "Have you filed a charge with the EEOC or FCHR?",
            ],
            documents: [
              "Any relevant emails",
              "Performance reviews",
              "HR complaint records",
            ],
            caseTypes: ["Workplace Discrimination", "Employment Discrimination"],
          },
        ],
      },
      {
        name: "Wage & Hour",
        subtypes: [
          {
            key: "emp.wage.unpaid",
            name: "Unpaid Wages / Overtime (FLSA)",
            questions: [
              "Employee's full legal name",
              "Job title and pay rate",
              "Estimated unpaid wages/overtime hours",
            ],
            documents: [
              "Pay stubs",
              "Time records",
              "Employment offer/agreement if available",
            ],
            caseTypes: ["Unpaid Wages / Overtime", "Wage and Hour"],
          },
        ],
      },
      {
        name: "Termination & Separation",
        subtypes: [
          {
            key: "emp.term.wrongful",
            name: "Wrongful Termination",
            questions: [
              "Employee's full legal name and position",
              "Hire date",
              "Termination date",
              "Describe the reason given for termination and why you believe it was unlawful.",
            ],
            caseTypes: ["Wrongful Termination"],
          },
        ],
      },
    ],
  },
  {
    name: "Real Estate Law",
    categories: [
      {
        name: "Residential Real Estate",
        subtypes: [
          {
            key: "re.res.purchase-sale",
            name: "Residential Purchase / Sale",
            questions: [
              "Buyer and seller names",
              "Property address",
              "Purchase price",
              "Anticipated closing date",
            ],
            documents: [
              "Purchase and sale contract",
              "Preliminary title report (if available)",
            ],
            caseTypes: ["Residential Purchase / Sale", "Residential Real Estate Transaction"],
          },
        ],
      },
      {
        name: "Landlord-Tenant",
        subtypes: [
          {
            key: "re.lt.eviction",
            name: "Eviction (Landlord)",
            questions: [
              "Landlord's full legal name",
              "Tenant's full legal name and property address",
              "Basis for eviction (non-payment, lease violation, holdover)",
            ],
            documents: [
              "Lease agreement",
              "Notice served on tenant",
              "Ledger of payments",
            ],
            caseTypes: ["Eviction (Landlord)", "Residential Eviction"],
          },
        ],
      },
      {
        name: "Financing",
        subtypes: [
          {
            key: "re.fin.foreclosure",
            name: "Foreclosure Defense",
            questions: [
              "Homeowner's full legal name",
              "Lender/servicer name and loan number",
              "Date of default",
              "Foreclosure case number (if filed)",
              "Describe the circumstances leading to default and any communication with the lender.",
            ],
            caseTypes: ["Foreclosure Defense"],
          },
        ],
      },
    ],
  },
];
