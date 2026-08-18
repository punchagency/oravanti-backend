/*
  Module-permission defaults, applied to one firm.

  These tables were global when this file was written, so it inserted rows with
  no organization_id. They have been per-firm for a long time now, and because
  src/db/seeds sits outside the build's tsconfig, the resulting type error was
  never reported — the script stayed in the tree, broken, and would have thrown
  a not-null violation on the first row had anyone run it.

  It now takes the firm to seed, and the matrix below is the only copy of these
  defaults in the repo, which is why the file is fixed rather than deleted.
*/
import { db } from "../client";
import { modulePermissions } from "../schema/module-permissions";

const defaults = [
  // Dashboard
  { module: "dashboard", role: "admin", permission: "full_access" },
  { module: "dashboard", role: "attorney", permission: "full_access" },
  { module: "dashboard", role: "paralegal", permission: "full_access" },
  { module: "dashboard", role: "client", permission: "view_only" },
  // Client Management
  { module: "client_management", role: "admin", permission: "full_access" },
  { module: "client_management", role: "attorney", permission: "full_access" },
  { module: "client_management", role: "paralegal", permission: "view_only" },
  { module: "client_management", role: "client", permission: "no_access" },
  // Cases
  { module: "cases", role: "admin", permission: "full_access" },
  { module: "cases", role: "attorney", permission: "full_access" },
  { module: "cases", role: "paralegal", permission: "assigned" },
  { module: "cases", role: "client", permission: "own_only" },
  // Documents
  { module: "documents", role: "admin", permission: "full_access" },
  { module: "documents", role: "attorney", permission: "full_access" },
  { module: "documents", role: "paralegal", permission: "assigned" },
  { module: "documents", role: "client", permission: "own_only" },
  // AI Error Detection
  { module: "ai_error_detection", role: "admin", permission: "full_access" },
  { module: "ai_error_detection", role: "attorney", permission: "full_access" },
  { module: "ai_error_detection", role: "paralegal", permission: "view_only" },
  { module: "ai_error_detection", role: "client", permission: "no_access" },
  // Workflow & Approvals
  { module: "workflow_approvals", role: "admin", permission: "full_access" },
  { module: "workflow_approvals", role: "attorney", permission: "approve" },
  { module: "workflow_approvals", role: "paralegal", permission: "submit" },
  { module: "workflow_approvals", role: "client", permission: "no_access" },
  // Tasks
  { module: "tasks", role: "admin", permission: "full_access" },
  { module: "tasks", role: "attorney", permission: "assign" },
  { module: "tasks", role: "paralegal", permission: "assigned" },
  { module: "tasks", role: "client", permission: "assigned" },
  // Time Tracking
  { module: "time_tracking", role: "admin", permission: "full_access" },
  { module: "time_tracking", role: "attorney", permission: "full_access" },
  { module: "time_tracking", role: "paralegal", permission: "own_only" },
  { module: "time_tracking", role: "client", permission: "no_access" },
  // Financial
  { module: "financial", role: "admin", permission: "full_access" },
  { module: "financial", role: "attorney", permission: "view_only" },
  { module: "financial", role: "paralegal", permission: "no_access" },
  { module: "financial", role: "client", permission: "payments" },
  // Education
  { module: "education", role: "admin", permission: "full_access" },
  { module: "education", role: "attorney", permission: "full_access" },
  { module: "education", role: "paralegal", permission: "full_access" },
  { module: "education", role: "client", permission: "assigned" },
  // Staff Management
  { module: "staff_management", role: "admin", permission: "full_access" },
  { module: "staff_management", role: "attorney", permission: "view_only" },
  { module: "staff_management", role: "paralegal", permission: "no_access" },
  { module: "staff_management", role: "client", permission: "no_access" },
  // USCIS Filing
  { module: "uscis_filing", role: "admin", permission: "full_access" },
  { module: "uscis_filing", role: "attorney", permission: "full_access" },
  { module: "uscis_filing", role: "paralegal", permission: "assigned" },
  { module: "uscis_filing", role: "client", permission: "own_only" },
  // Reports & Analytics
  { module: "reports_analytics", role: "admin", permission: "full_access" },
  { module: "reports_analytics", role: "attorney", permission: "view_only" },
  { module: "reports_analytics", role: "paralegal", permission: "no_access" },
  { module: "reports_analytics", role: "client", permission: "no_access" },
] as const;

export const seedModulePermissions = async (organizationId: string) => {
  // `defaults` is `as const`, so spreading each row also drops the readonly
  // that drizzle's insert overload rejects.
  await db
    .insert(modulePermissions)
    .values(defaults.map((d) => ({ ...d, organizationId })))
    .onConflictDoNothing();
};
