import { describe, expect, it } from "@jest/globals";
import {
  ACCESS_ACTION_NAMES,
  ACCESS_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTIONS,
  domainOf,
  isAccessAction,
  isAuditAction,
  labelFor,
} from "../../../src/lib/audit/actions";
import {
  auditActionTypeEnum,
  auditActorTypeEnum,
  auditCategoryEnum,
  auditSourceEnum,
} from "../../../src/db/schema/audit-events";
import {
  getRequestContext,
  runWithRequestContext,
} from "../../../src/middleware/request-context";

/**
 * The audit vocabulary.
 *
 * A closed catalogue only earns its keep if it stays coherent, and the ways it
 * stops being coherent are all silent: an action named off-convention lands in
 * the wrong bucket when a feed groups by domain; a view action added to the
 * audit registry starts being written to a table kept for seven years instead
 * of two; a category the pgEnum has never heard of fails at insert time, in
 * production, on the row that most needed writing.
 *
 * The pgEnum comparisons below duplicate the compile-time guards at the foot
 * of `db/schema/audit-events.ts` on purpose. Those catch a change to the
 * TypeScript unions; these additionally catch a change to the enum literals,
 * and they run even though `__tests__` sits outside the tsconfig include.
 */

const ACTION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

describe("the audit action registry", () => {
  it("is not empty", () => {
    expect(AUDIT_ACTION_NAMES.length).toBeGreaterThan(0);
    expect(ACCESS_ACTION_NAMES.length).toBeGreaterThan(0);
  });

  it("names every action domain.action in lower_snake", () => {
    const malformed = [...AUDIT_ACTION_NAMES, ...ACCESS_ACTION_NAMES].filter(
      (name) => !ACTION_NAME.test(name),
    );

    expect(malformed).toEqual([]);
  });

  it("keeps the two registries disjoint", () => {
    // The split between the tables is the whole reason `recordAuditEvent` and
    // `recordAccessEvent` take different types. An action in both would let a
    // view be written into the seven-year table by whichever writer got there
    // first, which is exactly the merge the split exists to prevent.
    const overlap = ACCESS_ACTION_NAMES.filter((name) =>
      Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, name),
    );

    expect(overlap).toEqual([]);
  });

  it("gives every audit action a category the database can store", () => {
    const allowed = new Set<string>(auditCategoryEnum.enumValues);
    const unknown = AUDIT_ACTION_NAMES.filter(
      (name) => !allowed.has(AUDIT_ACTIONS[name].category),
    );

    expect(unknown).toEqual([]);
  });

  it("gives every audit action a CRUD verb the database can store", () => {
    const allowed = new Set<string>(auditActionTypeEnum.enumValues);
    const unknown = AUDIT_ACTION_NAMES.filter(
      (name) => !allowed.has(AUDIT_ACTIONS[name].actionType),
    );

    expect(unknown).toEqual([]);
  });

  it("uses every category the schema declares", () => {
    // A category no action maps to is either a dead enum value or a body of
    // events nobody has got round to recording. Both are worth noticing.
    // The "access" category is used by ACCESS_ACTIONS (hardcoded in the
    // recordAccessEvent writer), not by AUDIT_ACTIONS.
    const auditUsed = new Set(AUDIT_ACTION_NAMES.map((n) => AUDIT_ACTIONS[n].category));
    const accessUsed = new Set(ACCESS_ACTION_NAMES.map(() => "access" as const));
    const used = new Set([...auditUsed, ...accessUsed]);

    expect([...used].sort()).toEqual([...auditCategoryEnum.enumValues].sort());
  });

  it("gives every action a non-empty entity type in lower_snake", () => {
    const definitions = [
      ...AUDIT_ACTION_NAMES.map((n) => [n, AUDIT_ACTIONS[n].entityType] as const),
      ...ACCESS_ACTION_NAMES.map((n) => [n, ACCESS_ACTIONS[n].entityType] as const),
    ];

    const malformed = definitions
      .filter(([, entityType]) => !/^[a-z][a-z0-9_]*$/.test(entityType))
      .map(([name]) => name);

    expect(malformed).toEqual([]);
  });

  it("gives every action a human label", () => {
    // The frontend renders this verbatim. An empty or lower-cased label shows
    // up as a blank or mis-capitalised row in a feed a client may be reading.
    const malformed = [
      ...AUDIT_ACTION_NAMES.map((n) => [n, AUDIT_ACTIONS[n].label] as const),
      ...ACCESS_ACTION_NAMES.map((n) => [n, ACCESS_ACTIONS[n].label] as const),
    ]
      .filter(([, label]) => label.trim().length === 0 || !/^[A-Z]/.test(label))
      .map(([name]) => name);

    expect(malformed).toEqual([]);
  });

  it("covers the authentication events that have no coverage today", () => {
    // Named individually rather than counted. These are the specific gaps the
    // audit called out — unrecorded failed sign-ins above all — and a count
    // would go green again if one were swapped for another.
    for (const action of [
      "auth.login",
      "auth.login_failed",
      "auth.logout",
      "auth.password_changed",
      "auth.password_reset_requested",
      "auth.password_reset_completed",
      "auth.two_factor_enabled",
      "auth.two_factor_disabled",
      "auth.backup_code_used",
      "auth.session_revoked",
    ]) {
      expect(isAuditAction(action)).toBe(true);
      expect(AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS].category).toBe("security");
    }
  });

  it("records the firm data reset, the operation that leaves no trace today", () => {
    expect(AUDIT_ACTIONS["admin.firm_data_reset"]).toMatchObject({
      category: "admin",
      actionType: "delete",
    });
  });

  it("treats reading the audit log as itself an access event", () => {
    expect(isAccessAction("audit_log.viewed")).toBe(true);
    expect(isAccessAction("audit_log.exported")).toBe(true);
  });
});

describe("registry helpers", () => {
  it("recognises known actions and rejects invented ones", () => {
    expect(isAuditAction("lead.stage_changed")).toBe(true);
    expect(isAuditAction("lead.viewed")).toBe(false); // an access action
    expect(isAuditAction("lead.invented_by_a_call_site")).toBe(false);

    expect(isAccessAction("document.downloaded")).toBe(true);
    expect(isAccessAction("document.created")).toBe(false);
  });

  it("is not fooled by inherited object properties", () => {
    // `"constructor" in obj` is true for every object. A plain `in` check here
    // would make `toString` a valid audit action.
    expect(isAuditAction("constructor")).toBe(false);
    expect(isAccessAction("toString")).toBe(false);
  });

  it("extracts the domain from either registry", () => {
    expect(domainOf("case.step_approved")).toBe("case");
    expect(domainOf("audit_log.viewed")).toBe("audit_log");
  });

  it("labels actions from both registries", () => {
    expect(labelFor("lead.stage_changed")).toBe("Stage changed");
    expect(labelFor("document.downloaded")).toBe("Document downloaded");
  });

  it("falls back to the raw name for an unknown action", () => {
    // A feed rendering a row written by a newer deployment should show
    // something readable rather than throw. The row is already in the table;
    // refusing to display it helps nobody.
    expect(labelFor("future.action_from_a_later_release")).toBe(
      "future.action_from_a_later_release",
    );
  });
});

describe("the storage enums track their sources", () => {
  it("stores every actor type the request context can produce", () => {
    // The writer copies `ctx.actorType` straight into the column. A type the
    // context can hold and the enum cannot is an insert failure at runtime.
    const contextActorTypes = ["staff", "client", "contractor", "system", "anonymous"];

    expect([...auditActorTypeEnum.enumValues].sort()).toEqual(contextActorTypes.sort());
  });

  it("stores every source the request context can produce", () => {
    const contextSources = ["http", "queue", "webhook", "cli", "system"];

    expect([...auditSourceEnum.enumValues].sort()).toEqual(contextSources.sort());
  });

  it("defaults an out-of-request context to values the enums accept", () => {
    // Queue jobs and CLI commands write audit rows too. Without a context they
    // fall back to the empty one, whose actor type and source must still be
    // storable — otherwise background work fails to record anything at all.
    const outside = getRequestContext();

    expect(auditActorTypeEnum.enumValues).toContain(outside.actorType);
    expect(auditSourceEnum.enumValues).toContain(outside.source);
  });

  it("accepts the actor type and source a queue job runs under", () => {
    runWithRequestContext({ source: "queue", actorType: "system" }, () => {
      const ctx = getRequestContext();

      expect(auditActorTypeEnum.enumValues).toContain(ctx.actorType);
      expect(auditSourceEnum.enumValues).toContain(ctx.source);
    });
  });
});
