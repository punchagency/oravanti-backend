/**
 * Seeds one system questionnaire per case type.
 * Questionnaire sections and questions are templated by practice area.
 * Safe to re-run — skips case types that already have a questionnaire.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../client";
import {
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  caseTypeQuestionnaireQuestions,
} from "../schema/questionnaires";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../schema/practice-area-subcategories";
import { practiceAreas } from "../schema/practice-areas";

// ─── Question input type ───────────────────────────────────────────────────────

type QType =
  | "short_text" | "long_text" | "number" | "email" | "phone"
  | "date" | "single_choice" | "multiple_choice" | "yes_no" | "file_upload";

type QInput = { label: string; type: QType; isRequired?: boolean; config?: Record<string, unknown> };
type SectionTemplate = { title: string; description?: string; questions: QInput[] };

// ─── Universal sections (appear on every questionnaire) ────────────────────────

const UNIVERSAL_SECTIONS: SectionTemplate[] = [
  {
    title: "About You",
    description: "Basic contact and identification information.",
    questions: [
      { label: "Full Legal Name", type: "short_text", isRequired: true },
      { label: "Date of Birth", type: "date" },
      { label: "Phone Number", type: "phone", isRequired: true },
      { label: "Email Address", type: "email", isRequired: true },
      { label: "Current Address", type: "short_text" },
      { label: "Preferred Language", type: "single_choice", config: { options: ["English", "Spanish", "French", "Portuguese", "Creole", "Other"] } },
      {
        label: "Are you contacting us on behalf of yourself or another person/entity?",
        type: "single_choice",
        isRequired: true,
        config: { options: ["Myself", "Another individual", "A business or organization"] },
      },
    ],
  },
  {
    title: "Your Situation",
    description: "Tell us about the legal matter you need help with.",
    questions: [
      { label: "Please describe your legal situation in detail", type: "long_text", isRequired: true },
      {
        label: "How urgent is your matter?",
        type: "single_choice",
        isRequired: true,
        config: { options: ["It's a crisis / I need help immediately", "Within the next few days", "Within the next few weeks", "I'm planning ahead — no immediate urgency"] },
      },
      { label: "Have you previously worked with an attorney on this matter?", type: "yes_no" },
      { label: "If yes, please provide details about prior legal representation", type: "long_text" },
      {
        label: "How did you hear about us?",
        type: "single_choice",
        config: { options: ["Referral from a friend or family", "Online search", "Social media", "Advertisement", "Community event", "Other"] },
      },
      { label: "Any additional context or documents you'd like us to be aware of?", type: "long_text" },
    ],
  },
];

// ─── Practice-area-specific section templates ──────────────────────────────────

const FAMILY_LAW_SECTIONS: SectionTemplate[] = [
  {
    title: "Family & Relationship Details",
    description: "Information about the parties involved.",
    questions: [
      { label: "Are you currently married?", type: "yes_no" },
      { label: "Date of Marriage", type: "date" },
      { label: "Date of Separation (if applicable)", type: "date" },
      { label: "Spouse / Partner Full Name", type: "short_text" },
      {
        label: "Do you and your spouse share any minor children?",
        type: "yes_no",
        isRequired: true,
      },
      { label: "Number of minor children", type: "number" },
      { label: "Ages of children (list all)", type: "short_text" },
      {
        label: "Is there a current court order regarding custody or support?",
        type: "yes_no",
      },
      { label: "County where divorce/family case would be filed", type: "short_text" },
    ],
  },
  {
    title: "Financial Overview",
    description: "A general picture of the marital/household finances.",
    questions: [
      { label: "Do you and your spouse own real property together?", type: "yes_no" },
      { label: "Approximate value of marital assets (total estimate)", type: "short_text" },
      { label: "Are there significant debts (mortgage, loans, credit cards)?", type: "yes_no" },
      { label: "Your approximate annual income", type: "short_text" },
      { label: "Spouse's approximate annual income (if known)", type: "short_text" },
      {
        label: "Is either party self-employed or a business owner?",
        type: "yes_no",
      },
      { label: "Are there retirement accounts or pension plans involved?", type: "yes_no" },
      { label: "Upload any relevant financial documents (optional)", type: "file_upload" },
    ],
  },
];

const CRIMINAL_LAW_SECTIONS: SectionTemplate[] = [
  {
    title: "Incident & Charge Details",
    description: "Information about the alleged offense.",
    questions: [
      { label: "What are the charge(s) you are facing?", type: "long_text", isRequired: true },
      { label: "Date of alleged incident", type: "date" },
      { label: "Location of alleged incident (city, county, state)", type: "short_text" },
      { label: "Were you arrested?", type: "yes_no", isRequired: true },
      { label: "Date of arrest (if applicable)", type: "date" },
      { label: "Are you currently in custody?", type: "yes_no", isRequired: true },
      { label: "Case number (if you have it)", type: "short_text" },
      { label: "Court where the case is pending", type: "short_text" },
      { label: "Next court date (if scheduled)", type: "date" },
      { label: "Name of the judge assigned (if known)", type: "short_text" },
      { label: "Do you have a police report or charging document? Please upload.", type: "file_upload" },
    ],
  },
  {
    title: "Prior Legal History",
    description: "Any prior criminal history that may be relevant.",
    questions: [
      { label: "Do you have any prior criminal convictions?", type: "yes_no" },
      { label: "If yes, please describe prior convictions (charge, year, state)", type: "long_text" },
      { label: "Have you been on probation or parole?", type: "yes_no" },
      { label: "Are there any other pending criminal matters?", type: "yes_no" },
    ],
  },
];

const PERSONAL_INJURY_SECTIONS: SectionTemplate[] = [
  {
    title: "Incident Details",
    description: "Information about how you were injured.",
    questions: [
      { label: "Date of incident", type: "date", isRequired: true },
      { label: "Location of incident (address or description)", type: "short_text", isRequired: true },
      { label: "Describe how the incident occurred", type: "long_text", isRequired: true },
      {
        label: "What type of incident was this?",
        type: "single_choice",
        isRequired: true,
        config: { options: ["Car / vehicle accident", "Slip or trip and fall", "Workplace / construction accident", "Medical malpractice", "Defective product", "Dog bite / animal attack", "Assault", "Other"] },
      },
      { label: "Were there any witnesses?", type: "yes_no" },
      { label: "Witness names and contact information (if known)", type: "long_text" },
      { label: "Was a police or incident report filed?", type: "yes_no" },
      { label: "Upload police report, incident report, or photos (optional)", type: "file_upload" },
    ],
  },
  {
    title: "Injuries & Medical Treatment",
    description: "Details about your injuries and treatment.",
    questions: [
      { label: "Describe your injuries", type: "long_text", isRequired: true },
      { label: "Did you receive emergency medical treatment?", type: "yes_no" },
      { label: "Name of treating physician or hospital", type: "short_text" },
      { label: "Are you still receiving medical treatment?", type: "yes_no" },
      { label: "Estimated total medical expenses to date", type: "short_text" },
      { label: "Have you missed work due to your injuries?", type: "yes_no" },
      { label: "Estimated lost wages", type: "short_text" },
    ],
  },
  {
    title: "Insurance Information",
    description: "Insurance coverage relevant to your claim.",
    questions: [
      { label: "Do you have health insurance?", type: "yes_no" },
      { label: "Health insurance provider and policy number", type: "short_text" },
      { label: "Do you have auto insurance? (if applicable)", type: "yes_no" },
      { label: "Have you filed a claim with any insurance company?", type: "yes_no" },
      { label: "Insurance company name and claim number (if applicable)", type: "short_text" },
      { label: "Has any insurance company made a settlement offer?", type: "yes_no" },
      { label: "Settlement amount offered (if any)", type: "short_text" },
    ],
  },
];

const IMMIGRATION_LAW_SECTIONS: SectionTemplate[] = [
  {
    title: "Immigration Status & Background",
    description: "Current immigration status and history.",
    questions: [
      { label: "Country of Birth", type: "short_text", isRequired: true },
      { label: "Country of Citizenship", type: "short_text", isRequired: true },
      {
        label: "Current immigration status",
        type: "single_choice",
        isRequired: true,
        config: { options: ["U.S. Citizen", "Lawful Permanent Resident (Green Card)", "Visa holder (non-immigrant)", "DACA recipient", "TPS holder", "Pending asylum applicant", "Undocumented", "Other"] },
      },
      { label: "If visa holder, what type of visa do you currently hold?", type: "short_text" },
      { label: "Visa expiration date (if applicable)", type: "date" },
      { label: "Date you first entered the United States", type: "date" },
      { label: "How long have you continuously lived in the United States?", type: "short_text" },
      { label: "A-Number (Alien Registration Number), if you have one", type: "short_text" },
      { label: "Receipt number(s) for any pending USCIS applications", type: "short_text" },
    ],
  },
  {
    title: "Prior Immigration History",
    description: "Any prior applications, petitions, or removal proceedings.",
    questions: [
      { label: "Have you previously filed any immigration applications or petitions?", type: "yes_no" },
      { label: "If yes, describe the application(s) and their outcomes", type: "long_text" },
      { label: "Have you ever been denied a visa or been found inadmissible?", type: "yes_no" },
      { label: "Have you ever been placed in removal (deportation) proceedings?", type: "yes_no" },
      { label: "Have you ever been removed or deported from the United States?", type: "yes_no" },
      { label: "Have you ever been convicted of a crime (in any country)?", type: "yes_no" },
      { label: "If yes, please describe any criminal history", type: "long_text" },
      { label: "Upload any immigration documents you have (passport, visa, I-94, prior notices)", type: "file_upload" },
    ],
  },
  {
    title: "Family Relationship Information",
    description: "Information about family ties relevant to immigration.",
    questions: [
      { label: "Are you married?", type: "yes_no" },
      { label: "Spouse's full name", type: "short_text" },
      { label: "Spouse's immigration status or citizenship", type: "short_text" },
      { label: "Do you have children?", type: "yes_no" },
      { label: "Do you have a U.S. citizen or permanent resident relative who might petition for you?", type: "yes_no" },
      { label: "Relationship to petitioning relative (if applicable)", type: "short_text" },
    ],
  },
];

const BUSINESS_LAW_SECTIONS: SectionTemplate[] = [
  {
    title: "Business Information",
    description: "Details about the business involved.",
    questions: [
      { label: "Business name (if applicable)", type: "short_text" },
      {
        label: "Type of business entity",
        type: "single_choice",
        config: { options: ["LLC", "Corporation (C-Corp)", "S-Corporation", "Partnership", "Sole proprietorship", "Non-profit", "Not yet formed", "Other"] },
      },
      { label: "State of formation / incorporation", type: "short_text" },
      { label: "Year business was established", type: "short_text" },
      { label: "Industry / type of business", type: "short_text" },
      { label: "Approximate annual revenue", type: "short_text" },
      { label: "Number of employees", type: "number" },
      { label: "Number of owners / members / partners", type: "number" },
    ],
  },
  {
    title: "Legal Matter Details",
    description: "Specifics of the business legal issue.",
    questions: [
      { label: "Describe the legal matter in detail", type: "long_text", isRequired: true },
      { label: "Are there any contracts or agreements involved?", type: "yes_no" },
      { label: "Have there been any communications or demands from the other party?", type: "yes_no" },
      { label: "Is there an existing dispute or litigation?", type: "yes_no" },
      { label: "Is there an immediate deadline or court date?", type: "yes_no" },
      { label: "If so, what is the date?", type: "date" },
      { label: "Upload any relevant contracts, agreements, or correspondence", type: "file_upload" },
    ],
  },
];

const ESTATE_PLANNING_SECTIONS: SectionTemplate[] = [
  {
    title: "Personal & Family Details",
    description: "Information needed for estate planning.",
    questions: [
      { label: "Date of Birth", type: "date", isRequired: true },
      { label: "Marital status", type: "single_choice", config: { options: ["Single", "Married", "Divorced", "Widowed", "Domestic partnership"] } },
      { label: "Spouse / Partner Full Name", type: "short_text" },
      { label: "Do you have children?", type: "yes_no" },
      { label: "Names and ages of your children", type: "long_text" },
      { label: "Do any of your children have special needs?", type: "yes_no" },
      { label: "Do you have grandchildren?", type: "yes_no" },
      {
        label: "General health status",
        type: "single_choice",
        config: { options: ["Excellent", "Good", "Fair", "Poor / have significant health concerns"] },
      },
      { label: "Do you have any existing estate planning documents?", type: "yes_no" },
    ],
  },
  {
    title: "Assets & Financial Overview",
    description: "Overview of assets and financial situation.",
    questions: [
      { label: "Do you own real property?", type: "yes_no" },
      { label: "Approximate value of real property holdings", type: "short_text" },
      { label: "Do you have retirement accounts (IRA, 401k, pension)?", type: "yes_no" },
      { label: "Do you have life insurance?", type: "yes_no" },
      { label: "Do you own a business?", type: "yes_no" },
      { label: "Approximate total estate value", type: "short_text" },
      { label: "Are there any significant debts?", type: "yes_no" },
      { label: "Do you have charitable giving or legacy goals?", type: "yes_no" },
    ],
  },
  {
    title: "Your Wishes & Goals",
    description: "What you'd like to accomplish with estate planning.",
    questions: [
      { label: "Describe your primary goals for this estate plan", type: "long_text", isRequired: true },
      { label: "Who are your intended primary beneficiaries?", type: "long_text", isRequired: true },
      { label: "Who would you want to serve as executor / personal representative?", type: "short_text" },
      { label: "Who would you want to serve as guardian for minor children (if applicable)?", type: "short_text" },
      { label: "Do you have specific wishes regarding healthcare decisions?", type: "long_text" },
      { label: "Are there assets you specifically want to keep separate from your estate?", type: "long_text" },
    ],
  },
];

const EMPLOYMENT_LAW_SECTIONS: SectionTemplate[] = [
  {
    title: "Employment Details",
    description: "Information about your employment situation.",
    questions: [
      { label: "Employer name", type: "short_text", isRequired: true },
      { label: "Your job title / position", type: "short_text" },
      { label: "Employment start date", type: "date" },
      { label: "Employment end date (if terminated)", type: "date" },
      {
        label: "Current employment status",
        type: "single_choice",
        isRequired: true,
        config: { options: ["Currently employed", "Recently terminated", "Resigned", "On leave", "Never started after offer"] },
      },
      { label: "Number of employees at the company (approximate)", type: "single_choice", config: { options: ["1–14", "15–49", "50–99", "100–499", "500+", "Unknown"] } },
      { label: "State where you worked", type: "short_text", isRequired: true },
    ],
  },
  {
    title: "Employment Issue Details",
    description: "The nature of your employment legal matter.",
    questions: [
      {
        label: "What best describes your employment issue?",
        type: "multiple_choice",
        isRequired: true,
        config: {
          options: [
            "Discrimination (race, sex, age, disability, national origin, etc.)",
            "Sexual harassment or hostile work environment",
            "Retaliation for protected activity",
            "Wrongful termination",
            "Wage / overtime violations",
            "FMLA or medical leave issues",
            "Disability accommodation denial",
            "Non-compete or severance agreement",
            "Whistleblower / reporting retaliation",
            "Other",
          ],
        },
      },
      { label: "Describe the key events and dates related to your issue", type: "long_text", isRequired: true },
      { label: "Have you reported this issue internally (HR, supervisor)?", type: "yes_no" },
      { label: "Have you filed a complaint with the EEOC, FCHR, or DOL?", type: "yes_no" },
      { label: "If yes, provide charge / complaint number and agency", type: "short_text" },
      { label: "Have you received a right-to-sue letter?", type: "yes_no" },
      { label: "Date of right-to-sue letter (if received)", type: "date" },
      { label: "Upload any relevant documents (termination letter, HR correspondence, pay stubs)", type: "file_upload" },
    ],
  },
];

const REAL_ESTATE_SECTIONS: SectionTemplate[] = [
  {
    title: "Property Information",
    description: "Details about the property involved.",
    questions: [
      { label: "Property address", type: "short_text", isRequired: true },
      {
        label: "Property type",
        type: "single_choice",
        isRequired: true,
        config: { options: ["Single-family home", "Condominium / townhome", "Multi-family residential", "Commercial / retail", "Land / vacant lot", "Industrial / warehouse", "Mixed-use", "Other"] },
      },
      { label: "Approximate property value", type: "short_text" },
      {
        label: "Is there a mortgage or lien on the property?",
        type: "yes_no",
      },
      { label: "Current owner(s) of the property", type: "short_text" },
      { label: "Upload property documents (deed, title, contract, survey — optional)", type: "file_upload" },
    ],
  },
  {
    title: "Transaction or Dispute Details",
    description: "Details about the transaction or legal matter.",
    questions: [
      {
        label: "Nature of the real estate matter",
        type: "single_choice",
        isRequired: true,
        config: {
          options: [
            "Purchase transaction",
            "Sale transaction",
            "Lease / landlord-tenant issue",
            "Foreclosure defense",
            "Title dispute",
            "Boundary / easement dispute",
            "Construction / mechanics lien",
            "Zoning / land use",
            "Other litigation",
          ],
        },
      },
      { label: "Describe the matter in detail", type: "long_text", isRequired: true },
      { label: "Is there a pending closing date or court deadline?", type: "yes_no" },
      { label: "If yes, what is the date?", type: "date" },
      { label: "Who is the other party in this matter (buyer, seller, tenant, lender, etc.)?", type: "short_text" },
      { label: "Has there been any previous litigation or court action related to this property?", type: "yes_no" },
    ],
  },
];

// ─── Map practice area names to their additional sections ─────────────────────

const PRACTICE_AREA_SECTIONS: Record<string, SectionTemplate[]> = {
  "Family Law": FAMILY_LAW_SECTIONS,
  "Criminal Law": CRIMINAL_LAW_SECTIONS,
  "Personal Injury Law": PERSONAL_INJURY_SECTIONS,
  "Immigration Law": IMMIGRATION_LAW_SECTIONS,
  "Business & Corporate Law": BUSINESS_LAW_SECTIONS,
  "Estate Planning": ESTATE_PLANNING_SECTIONS,
  "Employment Law": EMPLOYMENT_LAW_SECTIONS,
  "Real Estate Law": REAL_ESTATE_SECTIONS,
};

// ─── Seed function ─────────────────────────────────────────────────────────────

export const seedSystemQuestionnaires = async () => {
  console.log("Seeding system questionnaires...");

  // Load all case types with their practice area name for section selection
  const rows = await db
    .select({
      caseTypeId: practiceAreaCaseTypes.id,
      caseTypeName: practiceAreaCaseTypes.name,
      practiceAreaName: practiceAreas.name,
    })
    .from(practiceAreaCaseTypes)
    .innerJoin(practiceAreaSubcategories, eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id))
    .innerJoin(practiceAreas, eq(practiceAreaSubcategories.practiceAreaId, practiceAreas.id));

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    // Idempotent — skip if already seeded
    const [existing] = await db
      .select({ id: caseTypeQuestionnaires.id })
      .from(caseTypeQuestionnaires)
      .where(eq(caseTypeQuestionnaires.caseTypeId, row.caseTypeId))
      .limit(1);

    if (existing) {
      skipped++;
      continue;
    }

    const practiceAreaSections = PRACTICE_AREA_SECTIONS[row.practiceAreaName] ?? [];
    const allSections = [...UNIVERSAL_SECTIONS, ...practiceAreaSections];

    await db.transaction(async (tx) => {
      const [questionnaire] = await tx
        .insert(caseTypeQuestionnaires)
        .values({
          caseTypeId: row.caseTypeId,
          title: `${row.caseTypeName} — Client Intake`,
          description: `Standard intake questionnaire for ${row.caseTypeName} matters.`,
        })
        .returning();

      for (const [sIdx, section] of allSections.entries()) {
        const [sec] = await tx
          .insert(caseTypeQuestionnaireSections)
          .values({
            questionnaireId: questionnaire.id,
            title: section.title,
            description: section.description,
            orderIndex: sIdx,
          })
          .returning();

        for (const [qIdx, q] of section.questions.entries()) {
          await tx.insert(caseTypeQuestionnaireQuestions).values({
            questionnaireId: questionnaire.id,
            sectionId: sec.id,
            label: q.label,
            type: q.type,
            orderIndex: qIdx,
            isRequired: q.isRequired ?? false,
            config: (q.config ?? {}) as any,
          });
        }
      }
    });

    created++;
  }

  console.log(`System questionnaires: ${created} created, ${skipped} skipped (already existed).`);
};
