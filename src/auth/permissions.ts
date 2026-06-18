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
} as const;

export const ac = createAccessControl(statement);

export const paralegal = ac.newRole({
  cases: [],
  clients: [],
  staffs: [],
  ...memberAc.statements,
});

export const attorney = ac.newRole({
  cases: [],
  clients: [],
  staffs: [],
  ...memberAc.statements,
});

export const owner = ac.newRole({
  clients: [],
  cases: [],
  staffs: ["read", "create", "update", "delete"],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  clients: [],
  cases: [],
  staffs: [],
  ...adminAc.statements,
});

const memberRole = ac.newRole({
  ...memberAc.statements,
  clients: [],
  cases: [],
  staffs: [],
});

export const roleMap = {
  paralegal,
  attorney,
  owner,
  admin,
  member: memberRole,
} as const;
