import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const statement = {
  ...defaultStatements,
  cases: [],
  clients: [],
  staffs: [],
} as const;

export const ac = createAccessControl(statement);

export const attorney = ac.newRole({
  cases: [],
  clients: [],
  staffs: [],
  ...memberAc.statements,
});

export const owner = ac.newRole({
  clients: [],
  cases: [],
  staffs: [],
  ...ownerAc.statements,
});

export const admin = ac.newRole({
  clients: [],
  cases: [],
  staffs: [],
  ...adminAc.statements,
});
