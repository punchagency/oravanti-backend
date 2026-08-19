import { describe, expect, it } from "@jest/globals";
import { getTableName } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as bespokeRls from "../../../src/db/schema/rls";
import * as tenantRls from "../../../src/db/schema/rls-tenant";
import { RLS_EXEMPTIONS } from "../../../src/db/schema/rls-tenant";

/**
 * Every table is protected or explicitly exempt. There is no third state.
 *
 * RLS coverage used to be "the tables somebody got to" — 19 of 114 — and
 * nothing distinguished a table that had been considered and excluded from one
 * that had simply never come up. That is what this asserts against: not that
 * the policies are *correct* (only `npm run check 07-rls`, against a real
 * database and a role RLS applies to, can say that), but that **no table has
 * been silently skipped**.
 *
 * A new table fails here until someone decides which list it belongs in. That
 * friction is the point, and this is the cheapest moment to make the decision.
 *
 * The policies are read as objects rather than parsed out of the source,
 * because most of them are produced by factories in `rls-tenant.ts` — a regex
 * over `.link(...)` sees the parameter name, not the table.
 */

const SCHEMA_DIR = join(__dirname, "..", "..", "..", "src", "db", "schema");

type LinkedPolicy = {
  name: string;
  as?: string;
  _linkedTable: Parameters<typeof getTableName>[0];
};

const isLinkedPolicy = (value: unknown): value is LinkedPolicy =>
  typeof value === "object" &&
  value !== null &&
  "_linkedTable" in value &&
  Boolean((value as { _linkedTable?: unknown })._linkedTable);

/** Both RLS modules export policies singly and in arrays from the factories. */
const collectPolicies = (): LinkedPolicy[] => {
  const found: LinkedPolicy[] = [];

  for (const module of [bespokeRls, tenantRls]) {
    for (const exported of Object.values(module)) {
      if (Array.isArray(exported)) found.push(...exported.filter(isLinkedPolicy));
      else if (isLinkedPolicy(exported)) found.push(exported);
    }
  }

  return found;
};

/** Every `pgTable("…")` in the schema directory, ignoring commented-out ones. */
const collectTableNames = (): Set<string> => {
  const names = new Set<string>();

  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"))) {
    const live = readFileSync(join(SCHEMA_DIR, file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    for (const m of live.matchAll(/pgTable\(\s*["'`](\w+)["'`]/g)) {
      names.add(m[1]!);
    }
  }

  return names;
};

const policies = collectPolicies();
const allTables = collectTableNames();

const covered = new Set(policies.map((p) => getTableName(p._linkedTable)));

describe("RLS coverage", () => {
  it("finds the schema and the policies", () => {
    // A regex or an export shape that quietly stopped matching would otherwise
    // turn this whole suite green by finding nothing to check.
    expect(allTables.size).toBeGreaterThan(100);
    expect(policies.length).toBeGreaterThan(100);
    expect(covered.size).toBeGreaterThan(80);
  });

  it("covers or exempts every table", () => {
    const unaccounted = [...allTables]
      .filter((table) => !covered.has(table))
      .filter((table) => !Object.prototype.hasOwnProperty.call(RLS_EXEMPTIONS, table))
      .sort();

    expect({
      unaccounted,
      hint:
        unaccounted.length === 0
          ? undefined
          : "Add a policy in rls-tenant.ts, or add the table to RLS_EXEMPTIONS with a reason.",
    }).toEqual({ unaccounted: [], hint: undefined });
  });

  it("does not exempt a table that is also covered", () => {
    // An exemption left behind after a table gained policies reads as a
    // decision nobody made, and the next person to check believes it.
    const contradictory = [...covered]
      .filter((table) => Object.prototype.hasOwnProperty.call(RLS_EXEMPTIONS, table))
      .sort();

    expect(contradictory).toEqual([]);
  });

  it("does not exempt a table that no longer exists", () => {
    const stale = Object.keys(RLS_EXEMPTIONS)
      .filter((table) => !allTables.has(table))
      .sort();

    expect(stale).toEqual([]);
  });

  it("gives every exemption a real reason", () => {
    const weak = Object.entries(RLS_EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([table]) => table)
      .sort();

    expect(weak).toEqual([]);
  });

  /**
   * Postgres applies `(≥1 permissive passes) AND (all restrictive pass)`, so a
   * table whose only policies are restrictive returns **nothing at all**. Two
   * tables shipped in that state (`leads`, `lead_notes`) and it never bit,
   * because RLS is inert on the owner connection — which is precisely what
   * `scripts/apply-security-baseline.ts` changes.
   */
  it("never leaves a table with only restrictive policies", () => {
    const counts = new Map<string, { permissive: number; restrictive: number }>();

    for (const policy of policies) {
      const table = getTableName(policy._linkedTable);
      const entry = counts.get(table) ?? { permissive: 0, restrictive: 0 };
      if (policy.as === "restrictive") entry.restrictive += 1;
      else entry.permissive += 1;
      counts.set(table, entry);
    }

    const deniesEverything = [...counts.entries()]
      .filter(([, c]) => c.permissive === 0 && c.restrictive > 0)
      .map(([table]) => table)
      .sort();

    expect(deniesEverything).toEqual([]);
  });

  it("gives every policy a unique name", () => {
    // Two policies sharing a name is a migration error waiting to happen: the
    // second silently replaces the first.
    const seen = new Map<string, number>();
    for (const policy of policies) {
      seen.set(policy.name, (seen.get(policy.name) ?? 0) + 1);
    }

    const duplicated = [...seen.entries()]
      .filter(([, n]) => n > 1)
      .map(([name]) => name)
      .sort();

    expect(duplicated).toEqual([]);
  });
});
