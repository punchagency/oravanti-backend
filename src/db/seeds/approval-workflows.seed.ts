/*
  Approval-workflow defaults, applied to one firm.

  These tables were global when this file was written, so it inserted rows with
  no organization_id. They have been per-firm for a long time now, and because
  src/db/seeds sits outside the build's tsconfig, the resulting type error was
  never reported — the script stayed in the tree, broken, and would have thrown
  a not-null violation on the first row had anyone run it.

  It now takes the firm to seed, and the matrix below is the only copy of these
  defaults in the repo, which is why the file is fixed rather than deleted.
*/
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

export const seedApprovalWorkflows = async (organizationId: string) => {
  await db
    .insert(approvalWorkflows)
    .values(defaults.map((d) => ({ ...d, organizationId })))
    .onConflictDoNothing();
};

if (require.main === module) {
  const organizationId = process.argv[2];
  if (!organizationId) {
    console.error("usage: tsx src/db/seeds/approval-workflows.seed.ts <organizationId>");
    process.exit(1);
  }
  console.log("Seeding approval workflows...");
  seedApprovalWorkflows(organizationId)
    .then(() => {
      console.log("Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
