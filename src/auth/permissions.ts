import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  cases: ["read", "create", "update", "delete"],
  clients: ["read", "create", "update", "delete"],
  staffs: ["read", "create", "update", "delete"],
  invitations: ["read", "create", "update", "delete"],
  conflicts: ["review"], // conflict-check resolution (owners + admins only)
  documents: ["read", "download", "create", "update", "delete"], // download gates client docs
  case_review: ["read", "resolve", "configure"], // AI case review dashboard
  // The firm-wide audit trail. Reading it means reading every action every
  // colleague has taken, so it is an owner/admin surface — the per-entity
  // activity feeds on a lead or a matter are gated by that entity instead.
  audit: ["read", "export"],
  // Finance: invoicing, payments, time & billing, reports.
  // `trust` is the coarse yes/no on IOLTA data; `financial_access_controls`
  // holds the firm's own fine-grained answer and is checked as well.
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    "approve_time",
    "log_time",
    "trust",
  ],
} as const;

export const ac = createAccessControl(statement);

export const paralegal = ac.newRole({
  cases: [],
  clients: [],
  staffs: ["read"], // list attorneys for the consultation wizard
  conflicts: [],
  documents: ["read"],
  case_review: ["read"],
  audit: [],
  // Sees the billing screens and logs their own time. No invoice creation, no
  // money handling, no trust.
  finance: ["read", "log_time"],
  ...memberAc.statements,
});

export const attorney = ac.newRole({
  cases: ["read"],
  clients: [],
  staffs: ["read"], // list attorneys for the consultation wizard
  conflicts: [],
  documents: ["read", "download"],
  case_review: ["read"],
  audit: [],
  // Drafts an invoice for their own matter. Deliberately NOT record_payment or
  // approve_time — money handling and time approval stay with admin/owner, and
  // this role is kept thin by design.
  finance: ["read", "create", "log_time"],
  ...memberAc.statements,
});

export const owner = ac.newRole({
  clients: ["read", "create", "update", "delete"],
  cases: ["read", "create", "update", "delete"],
  staffs: ["read", "create", "update", "delete"],
  invitations: ["read", "create", "update", "delete"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  case_review: ["read", "resolve", "configure"],
  audit: ["read", "export"],
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    "approve_time",
    "log_time",
    "trust",
  ],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  clients: ["read", "create", "update", "delete"],
  cases: ["read", "create", "update", "delete"],
  staffs: ["read", "create", "update", "delete"],
  invitations: ["read", "create", "update", "delete"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  case_review: ["read", "resolve", "configure"],
  audit: ["read", "export"],
  finance: [
    "read",
    "create",
    "update",
    "record_payment",
    "approve_time",
    "log_time",
    "trust",
  ],
  ...adminAc.statements,
});

const memberRole = ac.newRole({
  ...memberAc.statements,
  clients: [],
  cases: [],
  staffs: [],
  conflicts: [],
  documents: [],
  case_review: [],
  audit: [],
  finance: [],
});

export const client = ac.newRole({
  cases: ["read"],
  clients: ["read"],
  staffs: [],
  conflicts: [],
  documents: ["read", "download"],
  case_review: [],
  audit: [],
  ...memberAc.statements,
});

export const roleMap = {
  paralegal,
  attorney,
  owner,
  admin,
  member: memberRole,
  client
} as const;

// ── Client & Contractor permission sets ──────────────────────────────────────
// These are static permission sets for non-staff user types.
// They don't use organization-based RBAC — access is controlled by RLS policies
// (user-ownership checks at the database level).

export const clientPermissions: Record<string, string[]> = {
  cases: ["read"],
  clients: ["read"],
  documents: ["read", "download"],
};

export const contractorPermissions: Record<string, string[]> = {
  cases: ["read"],
  clients: [],
  documents: ["read", "download"],
  staffs: [],
};

export type ClientPermissions = typeof clientPermissions;
export type ContractorPermissions = typeof contractorPermissions;
