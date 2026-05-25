import { db } from "../client";
import { approvalWorkflows } from "../schema/approval-workflows";

const defaults = [
  {
    workflowType: "case_submission" as const,
    chain: "Paralegal → Attorney → USCIS",
    isRequired: true,
    allowBypass: false,
  },
  {
    workflowType: "document_upload" as const,
    chain: "Client → Paralegal Review → Approved",
    isRequired: true,
    allowBypass: false,
  },
  {
    workflowType: "payment_processing" as const,
    chain: "Attorney → Admin → Trust Account",
    isRequired: true,
    allowBypass: false,
  },
  {
    workflowType: "client_addition" as const,
    chain: "Admin Only",
    isRequired: false,
    allowBypass: false,
  },
  {
    workflowType: "staff_certification" as const,
    chain: "Admin Approval Required",
    isRequired: true,
    allowBypass: false,
  },
];

async function seed() {
  console.log("Seeding approval workflows...");
  await db.insert(approvalWorkflows).values(defaults).onConflictDoNothing();
  console.log("Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
