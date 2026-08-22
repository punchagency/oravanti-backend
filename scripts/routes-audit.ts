/**
 * Print who can reach what.
 *
 *   npm run routes:audit            the summary and the gaps
 *   npm run routes:audit -- --all   every module, including the gated ones
 *
 * Run this before deciding which permission a new endpoint needs, and after
 * gating a module to watch the number come down. The same analyser backs
 * `__tests__/unit/routes/authorization-coverage.test.ts`, so what this prints
 * is exactly what CI enforces.
 */
import { join } from "node:path";
import {
  auditRoutes,
  coverageOf,
  summarise,
  type RouteModuleReport,
} from "../src/lib/route-audit";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

const bar = (value: number, total: number, width = 28): string => {
  const filled = total === 0 ? 0 : Math.round((value / total) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
};

const pct = (value: number, total: number) =>
  total === 0 ? "0%" : `${Math.round((value / total) * 100)}%`;

const LABEL: Record<ReturnType<typeof coverageOf>, string> = {
  resource: `${GREEN}router-gated${OFF}`,
  partial: `${YELLOW}partial${OFF}`,
  none: `${RED}ungated${OFF}`,
};

const row = (r: RouteModuleReport) =>
  `  ${r.module.padEnd(26)} ${String(r.routes).padStart(3)} routes   ${
    LABEL[coverageOf(r)]
  }${
    coverageOf(r) === "partial"
      ? `${DIM} (${r.permissionChecks} checks)${OFF}`
      : ""
  }`;

const main = () => {
  const showAll = process.argv.includes("--all");
  const reports = auditRoutes(join(__dirname, ".."));
  const s = summarise(reports);

  console.log(`\n${BOLD}Route authorization${OFF}`);
  console.log(`${DIM}${s.routes} routes across ${s.modules} modules${OFF}\n`);

  console.log(
    `  ${GREEN}router-gated${OFF}  ${bar(s.resourceGatedRoutes, s.routes)}  ${String(
      s.resourceGatedRoutes,
    ).padStart(3)}  ${pct(s.resourceGatedRoutes, s.routes)}`,
  );
  console.log(
    `  ${YELLOW}partial     ${OFF}  ${bar(s.partiallyGatedRoutes, s.routes)}  ${String(
      s.partiallyGatedRoutes,
    ).padStart(3)}  ${pct(s.partiallyGatedRoutes, s.routes)}`,
  );
  console.log(
    `  ${RED}ungated     ${OFF}  ${bar(s.ungatedRoutes, s.routes)}  ${String(
      s.ungatedRoutes,
    ).padStart(3)}  ${pct(s.ungatedRoutes, s.routes)}`,
  );

  console.log(`\n${BOLD}Ungated modules${OFF} ${DIM}— any authenticated user reaches these${OFF}`);
  if (s.ungatedModules.length === 0) {
    console.log(`  ${GREEN}none${OFF}`);
  } else {
    for (const r of s.ungatedModules) console.log(row(r));
  }

  if (s.unauthenticatedModules.length) {
    console.log(
      `\n${BOLD}No requireAuth${OFF} ${DIM}— reachable with no session at all${OFF}`,
    );
    for (const r of s.unauthenticatedModules) {
      console.log(`  ${r.module.padEnd(26)} ${String(r.routes).padStart(3)} routes   ${DIM}${r.file}${OFF}`);
    }
    console.log(
      `${DIM}  Expected for sign-in and for token-authenticated payment callbacks.${OFF}`,
    );
  }

  if (showAll) {
    console.log(`\n${BOLD}All modules${OFF}`);
    for (const r of reports) console.log(row(r));
  } else {
    console.log(`\n${DIM}  --all to list every module${OFF}`);
  }

  console.log(
    `\n${DIM}Gate a whole module by mounting requireResource("<resource>") on its router;` +
      `\nuse requirePermission({ resource: ["action"] }) for actions the HTTP method` +
      `\ndoes not imply. Resources are declared in src/auth/permissions.ts.${OFF}\n`,
  );
};

main();
