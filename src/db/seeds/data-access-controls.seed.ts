/*
  Data-access-control defaults, applied to one firm.

  These tables were global when this file was written, so it inserted rows with
  no organization_id. They have been per-firm for a long time now, and because
  src/db/seeds sits outside the build's tsconfig, the resulting type error was
  never reported — the script stayed in the tree, broken, and would have thrown
  a not-null violation on the first row had anyone run it.

  It now takes the firm to seed, and the matrix below is the only copy of these
  defaults in the repo, which is why the file is fixed rather than deleted.
*/
import { db } from "../client";
import { dataAccessControls } from "../schema/data-access-controls";

const defaults = [
  // Client Personal Information (PII)
  {
    dataType: "client_pii" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "client_pii" as const,
    role: "attorney" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "client_pii" as const,
    role: "paralegal" as const,
    permission: "assigned" as const,
  },
  {
    dataType: "client_pii" as const,
    role: "client" as const,
    permission: "own_only" as const,
  },

  // Case Documents
  {
    dataType: "case_documents" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "case_documents" as const,
    role: "attorney" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "case_documents" as const,
    role: "paralegal" as const,
    permission: "assigned" as const,
  },
  {
    dataType: "case_documents" as const,
    role: "client" as const,
    permission: "own_only" as const,
  },

  // Financial Records
  {
    dataType: "financial_records" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "financial_records" as const,
    role: "attorney" as const,
    permission: "view_only" as const,
  },
  {
    dataType: "financial_records" as const,
    role: "paralegal" as const,
    permission: "no_access" as const,
  },
  {
    dataType: "financial_records" as const,
    role: "client" as const,
    permission: "payments" as const,
  },

  // Staff Information
  {
    dataType: "staff_information" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "staff_information" as const,
    role: "attorney" as const,
    permission: "view_only" as const,
  },
  {
    dataType: "staff_information" as const,
    role: "paralegal" as const,
    permission: "no_access" as const,
  },
  {
    dataType: "staff_information" as const,
    role: "client" as const,
    permission: "no_access" as const,
  },

  // AI Error Flags
  {
    dataType: "ai_error_flags" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "ai_error_flags" as const,
    role: "attorney" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "ai_error_flags" as const,
    role: "paralegal" as const,
    permission: "view_only" as const,
  },
  {
    dataType: "ai_error_flags" as const,
    role: "client" as const,
    permission: "no_access" as const,
  },

  // Time Tracking Data
  {
    dataType: "time_tracking_data" as const,
    role: "admin" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "time_tracking_data" as const,
    role: "attorney" as const,
    permission: "full_access" as const,
  },
  {
    dataType: "time_tracking_data" as const,
    role: "paralegal" as const,
    permission: "own_only" as const,
  },
  {
    dataType: "time_tracking_data" as const,
    role: "client" as const,
    permission: "no_access" as const,
  },
];

export const seedDataAccessControls = async (organizationId: string) => {
  await db
    .insert(dataAccessControls)
    .values(defaults.map((d) => ({ ...d, organizationId })))
    .onConflictDoNothing();
};

if (require.main === module) {
  const organizationId = process.argv[2];
  if (!organizationId) {
    console.error("usage: tsx src/db/seeds/data-access-controls.seed.ts <organizationId>");
    process.exit(1);
  }
  console.log("Seeding data access controls...");
  seedDataAccessControls(organizationId)
    .then(() => {
      console.log("Done.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
