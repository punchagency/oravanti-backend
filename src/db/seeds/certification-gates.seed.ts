import { db } from "../client";
import { certifications } from "../schema/certifications";
import { paralegalCertificationGates } from "../schema/paralegal-certification-gates";

const defaultCertifications = [
  {
    code: "I-130",
    name: "Family Petition",
    description: "Petition for Alien Relative",
  },
  {
    code: "I-485",
    name: "Green Card",
    description: "Application to Register Permanent Residence",
  },
  {
    code: "I-765",
    name: "Work Permit",
    description: "Application for Employment Authorization",
  },
  {
    code: "I-140",
    name: "Employment",
    description: "Immigrant Petition for Alien Workers",
  },
  {
    code: "N-400",
    name: "Citizenship",
    description: "Application for Naturalization",
  },
  {
    code: "I-131",
    name: "Travel Document",
    description: "Application for Travel Document",
  },
  {
    code: "I-601",
    name: "Waiver",
    description: "Application for Waiver of Grounds of Inadmissibility",
  },
];

const defaultGates = [
  {
    action: "create_basic_forms",
    actionLabel: "Create Basic Forms (I-130, I-765)",
    requiredCertifications: ["I-130", "I-765"],
  },
  {
    action: "submit_for_review",
    actionLabel: "Submit Cases for Attorney Review",
    requiredCertifications: ["I-130", "I-485"],
  },
  {
    action: "handle_complex_cases",
    actionLabel: "Handle Complex Cases (I-140, I-601)",
    requiredCertifications: ["I-140", "I-601"],
  },
  {
    action: "uscis_filing_prep",
    actionLabel: "USCIS Filing Preparation",
    requiredCertifications: ["I-131", "I-485"],
  },
  {
    action: "waiver_applications",
    actionLabel: "Waiver Applications & Appeals",
    requiredCertifications: ["I-601"],
  },
] as const;

export const seedCertificationGates = async () => {
  await db
    .insert(certifications)
    .values(defaultCertifications)
    .onConflictDoNothing();
  await db
    .insert(paralegalCertificationGates)
    .values(defaultGates)
    .onConflictDoNothing();
  console.log("Certification gates seeded");
};
