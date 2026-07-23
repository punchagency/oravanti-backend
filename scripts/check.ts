import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { maskUrl, resolveTestDbTarget } from "./test-db/url";

/**
 * Runs a check script against the **test** database.
 *
 *   npm run check 03-issue-sync
 *   npm run check                 (lists available checks)
 *
 * The override works by replacing `DATABASE_URL` in the child process env before
 * any application module loads: `src/db/client.ts` builds both `systemDb` and
 * every `createTenantDb` connection from `env.databaseUrl`, which reads
 * `DATABASE_URL` at import time. Overriding it here is therefore enough to move
 * the entire app — including RLS tenant connections — onto the test database,
 * with no test-only branch inside `src/`.
 */
const CHECKS_DIR = join(__dirname, "checks");

const listChecks = () =>
  readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .sort();

const main = () => {
  const [name, ...rest] = process.argv.slice(2);

  if (!name) {
    console.log("Usage: npm run check <name> [-- args]\n\nAvailable checks:");
    for (const f of listChecks()) console.log(`  ${f.replace(/\.ts$/, "")}`);
    process.exit(1);
  }

  const file = join(CHECKS_DIR, name.endsWith(".ts") ? name : `${name}.ts`);
  if (!existsSync(file)) {
    console.error(`No such check: ${name}`);
    console.error(`Available: ${listChecks().map((f) => f.replace(/\.ts$/, "")).join(", ")}`);
    process.exit(1);
  }

  const { testUrl } = resolveTestDbTarget();
  console.log(`[check] ${name} against ${maskUrl(testUrl)}\n`);

  const result = spawnSync(
    "npx",
    ["tsx", file, ...rest],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "test" },
    },
  );

  process.exit(result.status ?? 1);
};

main();
