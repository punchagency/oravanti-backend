/**
 * Bring a database from empty to usable in one command.
 *
 *   npm run db:setup
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The schema lives in two places that must both be applied, and only one of
 * them is `db:push`:
 *
 *   - Tables, columns, enums, indexes and RLS *policies* come from
 *     `src/db/schema/*.ts` via drizzle-kit push.
 *   - Roles, GRANT/REVOKE, `FORCE ROW LEVEL SECURITY` and the two
 *     `get_current_*_id()` functions come from `apply-security-baseline.ts`.
 *
 * Running the first without the second leaves every policy defined and inert:
 * Postgres skips RLS for a table's owner unless it is forced, and migrations
 * run as the owner. That failure is silent — the policies are all there in
 * `pg_policies`, the app works, and no tenant boundary is enforced. It is the
 * exact condition this project has been in, and chaining the two steps is what
 * stops it recurring.
 *
 * ─── Ordering is load-bearing ───────────────────────────────────────────────
 *
 * Postgres validates a policy expression when the policy is created, so
 * `CREATE POLICY ... USING (organization_id = get_current_organization_id())`
 * fails outright if that function does not exist yet. But the rest of the
 * baseline grants on `organization` and `audit_events`, which push has not
 * created yet. Hence three steps, in exactly this order:
 *
 *   1. functions only   — enough for push's policies to validate
 *   2. push             — tables, policies
 *   3. full baseline    — roles, grants, FORCE RLS, verification
 *
 * Every step is idempotent, so re-running this on an existing database is
 * safe and is the supported way to pick up schema changes.
 *
 * Seeds are deliberately NOT chained. There are eight of them, most take an
 * organization id, and which ones a given environment wants is situational.
 * `npm run cli -- --help` lists them.
 */
import { spawnSync } from "node:child_process";

type Step = { name: string; command: string; args: string[]; why: string };

const STEPS: Step[] = [
  {
    name: "helper functions",
    command: "npm",
    args: ["run", "security:baseline", "--", "--functions-only"],
    why: "policies created by push reference these and fail to validate without them",
  },
  {
    name: "schema push",
    command: "npm",
    args: ["run", "db:push"],
    why: "tables, enums, indexes and the RLS policies themselves",
  },
  {
    name: "security baseline",
    command: "npm",
    args: ["run", "security:baseline"],
    why: "roles, grants, FORCE ROW LEVEL SECURITY — without this the policies are inert",
  },
];

const main = () => {
  const passthrough = process.argv.slice(2);

  console.log(`\ndb:setup — ${STEPS.length} steps, all idempotent\n`);

  for (const [i, step] of STEPS.entries()) {
    const n = `${i + 1}/${STEPS.length}`;
    console.log(`\x1b[1m[${n}] ${step.name}\x1b[0m`);
    console.log(`      ${step.why}`);

    const args = i === STEPS.length - 1 ? [...step.args, ...passthrough] : step.args;
    const result = spawnSync(step.command, args, {
      stdio: "inherit",
      // npm on Windows is npm.cmd, which is not directly executable.
      shell: process.platform === "win32",
    });

    if (result.status !== 0) {
      console.error(
        `\n\x1b[31m[${n}] ${step.name} failed (exit ${result.status}).\x1b[0m`,
      );
      console.error(
        "Nothing after this point ran. Fix the failure and re-run — every step is",
        "idempotent, so starting over costs nothing.\n",
      );
      process.exit(result.status ?? 1);
    }
    console.log("");
  }

  console.log("\x1b[32mdb:setup complete.\x1b[0m");
  console.log("Verify with:  npm run check 07-rls");
  console.log("Seed with:    npm run cli -- --help\n");
};

main();
