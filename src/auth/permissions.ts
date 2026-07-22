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
} as const;

export const ac = createAccessControl(statement);

export const paralegal = ac.newRole({
  cases: [],
  clients: [],
  staffs: ["read"], // list attorneys for the consultation wizard
  conflicts: [],
  documents: ["read"],
  ...memberAc.statements,
});

export const attorney = ac.newRole({
  cases: ["read"],
  clients: [],
  staffs: ["read"], // list attorneys for the consultation wizard
  conflicts: [],
  documents: ["read", "download"],
  ...memberAc.statements,
});

export const owner = ac.newRole({
  clients: [],
  cases: ["read", "create", "update", "delete"],
  staffs: ["read", "create", "update", "delete"],
  invitations: ["read", "create", "update", "delete"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  clients: [],
  cases: [],
  staffs: ["read", "create", "update", "delete"],
  invitations: ["read", "create", "update", "delete"],
  conflicts: ["review"],
  documents: ["read", "download", "create", "update", "delete"],
  ...adminAc.statements,
});

const memberRole = ac.newRole({
  ...memberAc.statements,
  clients: [],
  cases: [],
  staffs: [],
  conflicts: [],
  documents: [],
});

export const roleMap = {
  paralegal,
  attorney,
  owner,
  admin,
  member: memberRole,
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
