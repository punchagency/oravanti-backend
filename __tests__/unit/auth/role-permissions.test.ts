import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_PERMISSIONS,
  ac,
  admin,
  owner,
} from "../../../src/auth/permissions";

/*
  Two failures this pins down, both of which ship silently.

  1. A resource added to the statement but not granted to owner/admin. That is
     not a smaller grant — it is a total denial: `hasPermission` resolves the
     role's statements and finds no key, so the two roles that are supposed to
     have full access are the ONLY ones refused. It happened: adding `tasks`
     left Super admin and Admin 403-ing on every task route while paralegals
     worked fine.

  2. A resource added to the statement but missing from a default role's
     factory grants. New orgs get whatever `DEFAULT_ROLE_PERMISSIONS` says, so
     an absent key means every member of that role is denied the new surface
     with no visible cause — and `backfillDefaultRolePermissions` can only
     backfill keys that exist here to copy.

  Neither is a type error: the grant maps are `Record<string, readonly
  string[]>`, so an omitted key type-checks perfectly.

  jest's `expect` takes no message argument, so every assertion below is
  written to compare *lists of names* rather than booleans — a failure prints
  which resource, not just `false !== true`.
*/

/** better-auth's own org resources. Owner/admin get these from `ownerAc`/`adminAc`, deliberately not identically. */
const BETTER_AUTH_RESOURCES = new Set(["organization", "member", "invitation", "team", "ac"]);

const APP_RESOURCES = Object.keys(ac.statements).filter((r) => !BETTER_AUTH_RESOURCES.has(r));

const statementsOf = (role: { statements: unknown }) =>
  role.statements as Record<string, readonly string[]>;

const declaredActions = (resource: string) =>
  [...(ac.statements[resource as keyof typeof ac.statements] as readonly string[])].sort();

describe("owner and admin hold full access", () => {
  it.each([
    ["owner", owner],
    ["admin", admin],
  ])("%s grants every application resource", (_name, role) => {
    const statements = statementsOf(role);
    const missing = APP_RESOURCES.filter((r) => !(r in statements));

    expect(missing).toEqual([]);
  });

  it.each([
    ["owner", owner],
    ["admin", admin],
  ])("%s grants every action of those resources", (_name, role) => {
    const statements = statementsOf(role);

    // Name the resources whose action list falls short, so a failure reads
    // "['workflow']" rather than a diff of two long string arrays.
    const incomplete = APP_RESOURCES.filter((resource) => {
      const granted = [...(statements[resource] ?? [])].sort();
      return JSON.stringify(granted) !== JSON.stringify(declaredActions(resource));
    });

    expect(incomplete).toEqual([]);
  });

  it("distinguishes admin from owner only by better-auth's org operations", () => {
    // The one real difference: an admin cannot delete the organization.
    expect(statementsOf(owner).organization).toContain("delete");
    expect(statementsOf(admin).organization).not.toContain("delete");
  });
});

describe("default roles cover every resource", () => {
  it.each(DEFAULT_ROLE_NAMES)("%s names every application resource", (roleName) => {
    const grants = DEFAULT_ROLE_PERMISSIONS[roleName];
    const missing = APP_RESOURCES.filter((r) => !(r in grants));

    // An empty array is a decision ("this role reads no workflows"); an absent
    // key is an oversight. The distinction is the whole point of this test.
    expect(missing).toEqual([]);
  });

  it.each(DEFAULT_ROLE_NAMES)("%s grants only actions that exist", (roleName) => {
    const grants = DEFAULT_ROLE_PERMISSIONS[roleName] as Record<string, readonly string[]>;

    const undeclared = APP_RESOURCES.flatMap((resource) =>
      (grants[resource] ?? [])
        .filter((action) => !declaredActions(resource).includes(action))
        .map((action) => `${resource}:${action}`),
    );

    expect(undeclared).toEqual([]);
  });
});

describe("the workflow engine's own grants", () => {
  it("lets everyone who works a matter read the template behind it", () => {
    const cannotRead = (["attorney", "paralegal", "legal_assistant"] as const).filter(
      (role) => !DEFAULT_ROLE_PERMISSIONS[role].workflow.includes("read"),
    );

    expect(cannotRead).toEqual([]);
  });

  it("reserves editing a template to owner and admin", () => {
    // A template edit changes every future matter of that type. No default
    // staff role should be able to do it — that is the plan's
    // requireOwnerOrAdmin, expressed as a permission.
    const canEdit = DEFAULT_ROLE_NAMES.filter((role) =>
      DEFAULT_ROLE_PERMISSIONS[role].workflow.includes("update"),
    );

    expect(canEdit).toEqual([]);
  });

  it("lets every working role reach its own task queue", () => {
    const cannotReadTasks = DEFAULT_ROLE_NAMES.filter(
      (role) => !DEFAULT_ROLE_PERMISSIONS[role].tasks.includes("read"),
    );

    expect(cannotReadTasks).toEqual([]);
  });

  it("lets the paralegal work tasks but never delete one", () => {
    // Deleting a task is how a locked compliance step would disappear.
    expect(DEFAULT_ROLE_PERMISSIONS.paralegal.tasks).toEqual(
      expect.arrayContaining(["read", "create", "update"]),
    );
    expect(DEFAULT_ROLE_PERMISSIONS.paralegal.tasks).not.toContain("delete");
  });
});
