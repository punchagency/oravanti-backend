import { describe, expect, it } from "@jest/globals";
import { join } from "node:path";
import { auditRoutes, coverageOf, summarise } from "../../../src/lib/route-audit";

/*
  A ratchet on route authorization: the gap can shrink, never grow.

  ─── Why a ratchet and not an assertion ─────────────────────────────────────

  Authentication here is universal — every route module mounts `requireAuth`.
  Authorization is not: 92 routes across 18 modules carry no permission check,
  so any authenticated staff member reaches them whatever their role. Choosing
  the right permission for each is a product decision — may a paralegal void an
  invoice? — that no test can make.

  So this pins the current state exactly and fails only on regression. The
  budget below is a census of an open gap, NOT a list of things that are fine.

  ─── What this does NOT see ─────────────────────────────────────────────────

  `coverageOf` grades a whole MODULE, and a module counts as gated the moment
  it contains a single `requirePermission`. So an ungated route inside an
  otherwise-gated file is invisible here: `leads.routes.ts` declares 71 routes
  and holds three permission checks, and the other 68 have never appeared in
  any number below. `POST /leads/:id/consultation` — which sets a consultation
  fee — sat ungated behind exactly that blind spot.

  Per-route accounting would be the real fix. Until then, do not read a module's
  absence from the budget as evidence that its routes are gated.

  ─── When this fails ────────────────────────────────────────────────────────

  It prints which module and what to do. `npm run routes:audit` shows the whole
  picture. The two fixes are:

    • gate it     mount `requireResource("<resource>")` on the module's router,
                  then delete its line from the budget
    • it's public add it to PUBLICLY_REACHABLE with the reason

  Lowering a number is always allowed and never needs discussion.
*/

const reports = auditRoutes(join(__dirname, "..", "..", ".."));
const totals = summarise(reports);

/**
 * jest's `expect` takes no message argument, and the default output for a
 * failed `toEqual([])` is a bare array diff — which says *that* something is
 * ungated but not what to do. This throws the guidance instead, so a failure
 * reads as instructions rather than as a puzzle.
 */
function expectNone(items: string[], guidance: string): void {
  if (items.length === 0) return;
  throw new Error(`\n\n${guidance}\n`);
}

/**
 * Modules reachable with no session at all, and why that is correct.
 * Anything not listed here must mount `requireAuth`.
 */
const PUBLICLY_REACHABLE: Record<string, string> = {
  auth: "sign-in, sign-up and password reset — there is no session yet",
  "payments-public":
    "provider webhooks and token-authenticated payment pages: authenticated by signature or URL token, not by a session",
  "confido-webhooks":
    "Confido posts server-to-server with no session to present. The HMAC over the raw body is the authentication: it is verified before the payload is parsed, an unverifiable signature is a 401, and an unconfigured secret refuses outright rather than accepting unsigned events",
};

/**
 * Routes per module that have no permission gate at all.
 *
 * Most lines are an open authorization gap. Lower a number when you gate some
 * of a module's routes; delete the line when you gate all of them. Adding a
 * line, or raising a number, needs a reason.
 *
 * The exception is the modules also listed in PUBLICLY_REACHABLE — `auth`,
 * `payments-public`, `confido-webhooks`. A permission check needs a session to
 * check permissions *of*, and these are reached without one, so their routes
 * count as ungated here while being authenticated by other means. They are
 * listed rather than excluded so the census stays a count of what the resolver
 * actually sees, and so removing a module from PUBLICLY_REACHABLE cannot
 * quietly hide its routes.
 */
const UNGATED_BUDGET: Record<string, number> = {
  auth: 17,
  calendar: 9,
  "email-account": 9,
  "access-control": 7,
  security: 7,
  "client-responsiveness": 6,
  "consultation-settings": 6,
  tasks: 6,
  "firm-profile": 5,
  "practice-areas": 5,
  "payments-public": 3,
  "approval-workflows": 2,
  "data-access": 2,
  "firm-info": 2,
  "revenue-analytics": 2,
  "confido-webhooks": 1,
  // Not a gap. Both routes serve the caller their OWN notifications, scoped by
  // the session in the controller rather than by a query parameter. A firm-level
  // permission would be answering the wrong question — reading your own mail is
  // not a privilege a firm grants — and gating it would mean a role could be
  // configured such that a staff member cannot read notifications addressed to
  // them. See `.claude/workflows/02-backend-architecture.md § Routes`, which
  // specifies `requireAuth` for exactly these two.
  notifications: 2,
  onboarding: 1,
  "permission-audit-log": 1,
};

/** Total ungated routes when last measured. Ratcheted downward only. */
const UNGATED_ROUTE_BUDGET = 67;

describe("route authorization coverage", () => {
  it("discovers the route modules", () => {
    // A refactor that relocates route files would otherwise make every
    // assertion below vacuously pass.
    expect(reports.length).toBeGreaterThan(25);
    expect(totals.routes).toBeGreaterThan(300);
  });

  it("mounts requireAuth on every module that is not deliberately public", () => {
    const unexpected = totals.unauthenticatedModules
      .map((r) => r.module)
      .filter((m) => !(m in PUBLICLY_REACHABLE));

    expectNone(
      unexpected,
      [
        "  These route modules mount no requireAuth:",
        ...unexpected.map((m) => `    • ${m}`),
        "",
        "  Mount it on the router, or add the module to PUBLICLY_REACHABLE",
        "  in this file with the reason it needs no session.",
      ].join("\n"),
    );
  });

  it("adds no new ungated module", () => {
    const added = reports
      .filter((r) => coverageOf(r) === "none")
      .map((r) => r.module)
      .filter((m) => !(m in UNGATED_BUDGET))
      .sort();

    expectNone(
      added,
      [
        "  New route modules with no permission check at all:",
        ...added.map((m) => `    • ${m}`),
        "",
        "  Any authenticated user can reach every route in them.",
        '  Mount requireResource("<resource>") on the router, or add',
        "  requirePermission to each route.  →  npm run routes:audit",
      ].join("\n"),
    );
  });

  it("does not grow an existing module's ungated route count", () => {
    const grown = reports
      .filter((r) => coverageOf(r) === "none")
      .filter((r) => r.module in UNGATED_BUDGET)
      .filter((r) => r.routes > UNGATED_BUDGET[r.module])
      .map((r) => `    • ${r.module}: ${UNGATED_BUDGET[r.module]} → ${r.routes}`);

    expectNone(
      grown,
      [
        "  Routes were added to modules that have no permission check:",
        ...grown,
        "",
        "  Gate the module, or raise its number in UNGATED_BUDGET and say",
        "  why the new routes need no permission.",
      ].join("\n"),
    );
  });

  it("does not grow the total number of ungated routes", () => {
    expectNone(
      totals.ungatedRoutes > UNGATED_ROUTE_BUDGET
        ? [`${totals.ungatedRoutes} > ${UNGATED_ROUTE_BUDGET}`]
        : [],
      [
        `  Ungated routes rose to ${totals.ungatedRoutes}; the budget is ${UNGATED_ROUTE_BUDGET}.`,
        "  Gate the new routes, or raise the budget and say why.",
        "  →  npm run routes:audit",
      ].join("\n"),
    );

    /*
      Going the other way is the goal, not a failure. Nudge rather than break:
      a green build should never depend on someone having remembered to lower
      a constant.
    */
    if (totals.ungatedRoutes < UNGATED_ROUTE_BUDGET) {
      console.log(
        `  ↓ ungated routes are down to ${totals.ungatedRoutes} (budget ` +
          `${UNGATED_ROUTE_BUDGET}) — lower UNGATED_ROUTE_BUDGET to lock it in`,
      );
    }
  });
});
