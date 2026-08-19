/**
 * Who can reach which endpoint — measured from the route files themselves.
 *
 * Shared by `npm run routes:audit` (the readable report) and by
 * `__tests__/unit/routes/authorization-coverage.test.ts` (the gate that stops
 * the gap widening). One implementation, so the number the report prints and
 * the number the test enforces can never disagree.
 *
 * ─── The three ways a route can be gated ────────────────────────────────────
 *
 *   `requireResource("cases")` on the router
 *       Gates everything mounted under it, deriving create/read/update/delete
 *       from the HTTP method. Preferred: a route added next month inherits the
 *       gate instead of needing someone to remember.
 *
 *   `requirePermission({ audit: ["read"] })` on one route
 *       For actions the method does not imply — an export is a GET, but it
 *       takes copies of firm records out of the system.
 *
 *   Nothing
 *       Any authenticated user reaches it, whatever their role.
 *
 * Counting `requirePermission` alone badly understates coverage, because it
 * misses every route gated by the first form. That is why this exists rather
 * than a grep.
 *
 * ─── What it cannot see ─────────────────────────────────────────────────────
 *
 * Static analysis of source text. It knows a gate is *present*, not that it is
 * the *right* gate — whether `documents:update` is the correct permission for
 * a given PATCH is a product decision no parser can make.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RouteModuleReport = {
  /** Module name, e.g. "cases" — the filename without `.routes.ts`. */
  module: string;
  /** Path relative to src/modules, for pointing someone at the file. */
  file: string;
  routes: number;
  /** `requireAuth` mounted on the router. */
  authenticated: boolean;
  /** `requireResource(...)` mounted on the router: gates every route under it. */
  resourceGated: boolean;
  /** Count of per-route `requirePermission(...)` calls. */
  permissionChecks: number;
};

export type Coverage = "resource" | "partial" | "none";

/** How a module is gated, in one word. */
export const coverageOf = (r: RouteModuleReport): Coverage =>
  r.resourceGated ? "resource" : r.permissionChecks > 0 ? "partial" : "none";

const ROUTE_DECL = /\.(get|post|put|patch|delete)\s*\(/g;

/*
  Matched against `.use(...)` rather than anywhere in the file, because a route
  file that merely imports requireAuth has not mounted it. The `s` flag lets a
  `.use()` call span lines, which most of them do.
*/
const MOUNTS_AUTH = /\.use\([^)]*requireAuth/s;
const MOUNTS_RESOURCE = /\.use\([^)]*requireResource\(/s;

const modulesDir = (root: string) => join(root, "src", "modules");

function routeFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFilesIn(full));
    else if (entry.name.endsWith(".routes.ts")) out.push(full);
  }
  return out;
}

/** Read every `*.routes.ts` under `src/modules` and report on each. */
export function auditRoutes(repoRoot: string): RouteModuleReport[] {
  const base = modulesDir(repoRoot);
  return routeFilesIn(base)
    .map((path) => {
      const src = readFileSync(path, "utf8");
      const file = path.slice(base.length + 1).split("\\").join("/");
      return {
        module: file.split("/").pop()!.replace(".routes.ts", ""),
        file,
        routes: (src.match(ROUTE_DECL) ?? []).length,
        authenticated: MOUNTS_AUTH.test(src),
        resourceGated: MOUNTS_RESOURCE.test(src),
        permissionChecks: (src.match(/requirePermission\s*\(/g) ?? []).length,
      };
    })
    .filter((r) => r.routes > 0)
    .sort((a, b) => b.routes - a.routes);
}

export type CoverageTotals = {
  modules: number;
  routes: number;
  resourceGatedRoutes: number;
  partiallyGatedRoutes: number;
  ungatedRoutes: number;
  ungatedModules: RouteModuleReport[];
  unauthenticatedModules: RouteModuleReport[];
};

export function summarise(reports: RouteModuleReport[]): CoverageTotals {
  const by = (c: Coverage) => reports.filter((r) => coverageOf(r) === c);
  const sum = (rs: RouteModuleReport[]) =>
    rs.reduce((total, r) => total + r.routes, 0);

  return {
    modules: reports.length,
    routes: sum(reports),
    resourceGatedRoutes: sum(by("resource")),
    partiallyGatedRoutes: sum(by("partial")),
    ungatedRoutes: sum(by("none")),
    ungatedModules: by("none"),
    unauthenticatedModules: reports.filter((r) => !r.authenticated),
  };
}
