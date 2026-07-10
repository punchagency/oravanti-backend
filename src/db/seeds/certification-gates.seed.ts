import { db } from "../client";
import { eq } from "drizzle-orm";
import { certifications } from "../schema/cases";
import { organization } from "../schema/auth-schema";
import { paralegalCertificationGates } from "../schema/paralegal-certification-gates";

const defaultCertifications = [
  {
    name: "Family Petition",
    level: "intermediate" as const,
    description: "Petition for Alien Relative (I-130)",
  },
  {
    name: "Green Card",
    level: "intermediate" as const,
    description: "Application to Register Permanent Residence (I-485)",
  },
  {
    name: "Work Permit",
    level: "basic" as const,
    description: "Application for Employment Authorization (I-765)",
  },
  {
    name: "Employment",
    level: "advanced" as const,
    description: "Immigrant Petition for Alien Workers (I-140)",
  },
  {
    name: "Citizenship",
    level: "advanced" as const,
    description: "Application for Naturalization (N-400)",
  },
  {
    name: "Travel Document",
    level: "basic" as const,
    description: "Application for Travel Document (I-131)",
  },
  {
    name: "Waiver",
    level: "advanced" as const,
    description: "Application for Waiver of Grounds of Inadmissibility (I-601)",
  },
];

const defaultGates = [
  {
    action: "create_basic_forms" as const,
    actionLabel: "Create Basic Forms (I-130, I-765)",
    requiredCertifications: ["Work Permit", "Family Petition"],
  },
  {
    action: "submit_for_review" as const,
    actionLabel: "Submit Cases for Attorney Review",
    requiredCertifications: ["Family Petition", "Green Card"],
  },
  {
    action: "handle_complex_cases" as const,
    actionLabel: "Handle Complex Cases (I-140, I-601)",
    requiredCertifications: ["Employment", "Waiver"],
  },
  {
    action: "uscis_filing_prep" as const,
    actionLabel: "USCIS Filing Preparation",
    requiredCertifications: ["Travel Document", "Green Card"],
  },
  {
    action: "waiver_applications" as const,
    actionLabel: "Waiver Applications & Appeals",
    requiredCertifications: ["Waiver"],
  },
];

export const seedCertificationGates = async (organizationId?: string) => {
  let orgId = organizationId;
  if (!orgId) {
    const [org] = await db.select({ id: organization.id }).from(organization).limit(1);
    if (!org) {
      console.error("No organization found. Skipping certification gates.");
      return;
    }
    orgId = org.id;
  }

  await db
    .insert(certifications)
    .values(defaultCertifications.map((c) => ({ ...c, organizationId: orgId })))
    .onConflictDoNothing();

  await db
    .insert(paralegalCertificationGates)
    .values(defaultGates.map((g) => ({ ...g, organizationId: orgId })))
    .onConflictDoNothing();

  console.log("Certification gates seeded");
};
