import { db } from "../client";
import { eq } from "drizzle-orm";
import { certifications } from "../schema/cases";
import { organization } from "../schema/auth-schema";

const defaults = [
  // Basic
  {
    name: "Immigration Law Fundamentals",
    level: "basic" as const,
    description: "Core principles of U.S. immigration law and procedure",
  },
  {
    name: "Legal Ethics & Compliance",
    level: "basic" as const,
    description: "Professional responsibility and regulatory compliance",
  },
  // Intermediate
  {
    name: "I-485 Form Processing",
    level: "intermediate" as const,
    description: "Application to Register Permanent Residence or Adjust Status",
  },
  {
    name: "I-130 Petition Filing",
    level: "intermediate" as const,
    description: "Petition for Alien Relative",
  },
  {
    name: "I-129 Nonimmigrant Worker Petition",
    level: "intermediate" as const,
    description: "Petition for Nonimmigrant Worker",
  },
  {
    name: "Client Communication & Case Management",
    level: "intermediate" as const,
    description: "Effective client relations and case workflow management",
  },
  // Advanced
  {
    name: "I-140 Immigrant Petition",
    level: "advanced" as const,
    description: "Immigrant Petition for Alien Workers",
  },
  {
    name: "Asylum Application Procedures",
    level: "advanced" as const,
    description: "Affirmative and defensive asylum application processing",
  },
  {
    name: "H-1B Visa Processing",
    level: "advanced" as const,
    description: "Specialty occupation visa petition preparation",
  },
  {
    name: "Naturalization & Citizenship",
    level: "advanced" as const,
    description: "Application for Naturalization (N-400) processing",
  },
  // Expert
  {
    name: "Employment-Based Visa Processing",
    level: "expert" as const,
    description: "EB-1 through EB-5 immigrant visa categories",
  },
  {
    name: "USCIS Electronic Filing Certified",
    level: "expert" as const,
    description: "Certified in USCIS electronic filing systems and procedures",
  },
];

export const seedCertifications = async (organizationId?: string) => {
  let orgId = organizationId;
  if (!orgId) {
    const [org] = await db.select({ id: organization.id }).from(organization).limit(1);
    if (!org) {
      console.error("No organization found. Run seed-staff-teams or demo-data seed first.");
      return;
    }
    orgId = org.id;
  }

  const values = defaults.map((cert) => ({ ...cert, organizationId: orgId }));
  await db.insert(certifications).values(values).onConflictDoNothing();
  console.log(`Seeded ${values.length} certifications`);
};

const runningDirectly =
  process.argv.length > 1 &&
  process.argv[1]!.replace(/\\/g, "/").includes("certifications.seed");

if (runningDirectly) {
  seedCertifications()
    .then(() => {
      console.log("Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
