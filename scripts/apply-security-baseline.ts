import "dotenv/config";
import postgres from "postgres";
import { RLS_EXEMPTIONS } from "../src/db/schema/rls-tenant";

/**
 * The database-level half of tenancy and audit immutability.
 *
 * Everything here is what a migration cannot express. Drizzle owns tables,
 * columns and policies; it does not own roles, grants, `FORCE ROW LEVEL
 * SECURITY`, or the two functions the policies call. Those were previously
 * created by hand in the development database and by `scripts/test-db/setup.ts`
 * in the test one, which meant **no environment except the test database could
 * be relied on to have them** — the policies in `src/db/schema/rls.ts` would
 * apply against a role that bypasses them, and nobody would notice.
 *
 * Idempotent: safe to run on every deploy, and the common case is a no-op.
 *
 * ─── What it establishes ────────────────────────────────────────────────────
 *
 *   1. `get_current_organization_id()` / `get_current_user_id()` — the two
 *      functions every policy calls.
 *   2. `oravanti_app` — NOSUPERUSER, NOBYPASSRLS, owns nothing. RLS actually
 *      applies to it, which is not true of the role the app connects as today.
 *   3. `FORCE ROW LEVEL SECURITY` on every RLS-enabled table, so policies bind
 *      even for the table owner.
 *   4. **`audit_events`: `SELECT` and `INSERT` only.** No `UPDATE`, no
 *      `DELETE`, for anyone but the maintenance role. This is the step that
 *      turns "no code deletes the audit trail" from a convention into a thing
 *      the database refuses.
 *   5. `oravanti_maintenance` — the only role that may delete audit rows, used
 *      by the retention job and nothing else.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   npm run security:baseline -- --dry-run     # print the SQL, change nothing
 *   npm run security:baseline                  # apply to DATABASE_URL
 *   npm run security:baseline -- --confirm-production
 *   npm run security:baseline -- --functions-only
 *
 * ─── `--functions-only`, and why a fresh database needs it ──────────────────
 *
 * Postgres validates a policy expression when the policy is created, so
 * `CREATE POLICY … USING (organization_id = get_current_organization_id())`
 * fails outright if that function does not exist yet. On an empty database the
 * very first policy migration is therefore the thing that breaks, with
 * `function get_current_organization_id() does not exist`.
 *
 * The rest of this script cannot run before the migration either — it grants on
 * `organization` and `audit_events`, which do not exist yet. So a clean slate
 * has a strict order: functions, then migrate, then the full baseline.
 * `--functions-only` is the first of those three, and nothing else.
 *
 * Passwords come from `ORAVANTI_APP_DB_PASSWORD` and
 * `ORAVANTI_MAINTENANCE_DB_PASSWORD`. They are only needed when the roles are
 * first created; a re-run without them leaves existing passwords untouched.
 */

const APP_ROLE = "oravanti_app";
const MAINTENANCE_ROLE = "oravanti_maintenance";

/**
 * Tables the app must never mutate after insert.
 *
 * Not derived from the schema: this list is a policy decision, and it should
 * take a deliberate edit here — plus a reviewer — to make an append-only table
 * mutable again.
 */
const APPEND_ONLY_TABLES = ["audit_events"];

type Args = {
  dryRun: boolean;
  confirmProduction: boolean;
  functionsOnly: boolean;
};

const parseArgs = (argv: string[]): Args => ({
  dryRun: argv.includes("--dry-run"),
  confirmProduction: argv.includes("--confirm-production"),
  functionsOnly: argv.includes("--functions-only"),
});

/** Doubles embedded quotes so a role name can never break out of its literal. */
const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Postgres identifiers cannot be parameterised; this is the only safe form. */
const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const helperFunctions = () => `
-- The two functions every policy in src/db/schema/rls.ts calls. SECURITY
-- DEFINER so they read the setting regardless of the caller's privileges;
-- STABLE so the planner may cache them within a statement. The second argument
-- to current_setting (missing_ok) makes an unset variable return NULL instead
-- of raising, which is what lets an unauthenticated connection see nothing
-- rather than error.
CREATE OR REPLACE FUNCTION public.get_current_organization_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::text;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::text;
$$;
`;

const createRole = (role: string, password: string | undefined) => `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    ${
      password
        ? `CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)};`
        : `RAISE EXCEPTION ${quoteLiteral(
            `Role ${role} does not exist and no password was supplied. Set the matching *_DB_PASSWORD environment variable.`,
          )};`
    }
  END IF;
END
$$;

-- Reasserted on every run, not only at creation: a role that acquired
-- BYPASSRLS or SUPERUSER out of band is exactly the failure this file exists
-- to prevent, and it would be silent.
ALTER ROLE ${quoteIdent(role)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
`;

/**
 * `FORCE` matters as much as `ENABLE`.
 *
 * Drizzle emits `ENABLE ROW LEVEL SECURITY` for any table carrying a linked
 * policy, but Postgres skips RLS for a table's **owner** unless the table is
 * also `FORCE`d. Migrations run as the owner, so without this the policies
 * are inert on precisely the connection that matters most.
 */
const forceRlsOnCoveredTables = `
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity          -- RLS enabled by the migration
      AND NOT c.relforcerowsecurity -- but not yet forced
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.relname);
    RAISE NOTICE 'forced RLS on %', target.relname;
  END LOOP;
END
$$;
`;

const appGrants = () => {
  const appendOnlyList = APPEND_ONLY_TABLES.map(quoteLiteral).join(", ");

  return `
GRANT USAGE ON SCHEMA public TO ${quoteIdent(APP_ROLE)};

-- Broad DML first, then revoked back on the append-only tables below. Doing it
-- in this order means a table added later is mutable by default and has to be
-- named in APPEND_ONLY_TABLES to become immutable — the safe direction for a
-- grant script to fail in.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdent(APP_ROLE)};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdent(APP_ROLE)};

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(APP_ROLE)};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(APP_ROLE)};

-- Step 35. The audit trail is append-only at the grant level, so a bug, an
-- injected statement or a careless migration cannot rewrite history — only the
-- maintenance role can remove a row, and only for retention.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[${appendOnlyList}]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = target
    ) THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM %I', target, ${quoteLiteral(APP_ROLE)});
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO %I', target, ${quoteLiteral(APP_ROLE)});
      RAISE NOTICE 'append-only: % (select, insert only)', target;
    ELSE
      RAISE WARNING 'append-only table % does not exist — skipped', target;
    END IF;
  END LOOP;
END
$$;
`;
};

const maintenanceGrants = () => {
  const appendOnlyList = APPEND_ONLY_TABLES.map(quoteLiteral).join(", ");

  return `
GRANT USAGE ON SCHEMA public TO ${quoteIdent(MAINTENANCE_ROLE)};

-- Deliberately narrow: the retention job reads and deletes audit rows and does
-- nothing else. It is not a second application account.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[${appendOnlyList}]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = target
    ) THEN
      EXECUTE format('GRANT SELECT, DELETE ON public.%I TO %I', target, ${quoteLiteral(MAINTENANCE_ROLE)});
    END IF;
  END LOOP;
END
$$;

-- The retention job reads each firm's configured window before deleting.
GRANT SELECT ON public.organization TO ${quoteIdent(MAINTENANCE_ROLE)};

-- RLS applies to this role too, and it sets no org — so it needs an explicit
-- permissive policy or it would see nothing to delete. Scoped to audit_events
-- and to this role alone.
DROP POLICY IF EXISTS rls_audit_events_maintenance ON public.audit_events;
CREATE POLICY rls_audit_events_maintenance ON public.audit_events
  AS PERMISSIVE FOR ALL
  TO ${quoteIdent(MAINTENANCE_ROLE)}
  USING (true);
`;
};

/**
 * Reports what the database now believes, rather than what the script just
 * asked for. A grant script that only prints its own intentions is how a
 * partially-applied baseline goes unnoticed.
 */
const verify = async (sql: postgres.Sql) => {
  const roles = await sql<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname IN (${APP_ROLE}, ${MAINTENANCE_ROLE})
    ORDER BY rolname
  `;

  const unforced = await sql<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
    ORDER BY c.relname
  `;

  const auditPrivileges = await sql<{ privilege_type: string }[]>`
    SELECT privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'audit_events'
      AND grantee = ${APP_ROLE}
    ORDER BY privilege_type
  `;

  /*
    Coverage, checked against the database rather than the schema.

    The unit test asserts the same invariant over the source, which catches it
    in CI. This catches the other half: a database where a policy migration was
    never applied, or where someone disabled RLS by hand. The schema being
    right is not evidence that the deployed database is.
  */
  const liveTables = await sql<{ relname: string; rowsecurity: boolean }[]>`
    SELECT c.relname, c.relrowsecurity AS rowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE '\\_\\_drizzle%'
    ORDER BY c.relname
  `;

  const unprotected = liveTables
    .filter((t) => !t.rowsecurity)
    .filter((t) => !Object.prototype.hasOwnProperty.call(RLS_EXEMPTIONS, t.relname))
    .map((t) => t.relname);

  const helpers = await sql<{ proname: string }[]>`
    SELECT proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND proname IN ('get_current_organization_id', 'get_current_user_id')
    ORDER BY proname
  `;

  console.log("\n── Verification ──────────────────────────────────────────");

  console.log(
    helpers.length === 2
      ? "  ✓ both RLS helper functions exist"
      : `  ✗ missing helper function(s): expected 2, found ${helpers.length}`,
  );

  for (const role of roles) {
    const flags = [
      role.rolsuper ? "SUPERUSER" : "nosuperuser",
      role.rolbypassrls ? "BYPASSRLS" : "nobypassrls",
    ].join(", ");
    const bad = role.rolsuper || role.rolbypassrls;
    console.log(`  ${bad ? "✗" : "✓"} role ${role.rolname}: ${flags}`);
  }

  if (roles.length < 2) {
    console.log(`  ✗ expected 2 roles, found ${roles.length}`);
  }

  console.log(
    unforced.length === 0
      ? "  ✓ every RLS-enabled table is FORCEd"
      : `  ✗ RLS enabled but not forced: ${unforced.map((t) => t.relname).join(", ")}`,
  );

  const protectedCount = liveTables.filter((t) => t.rowsecurity).length;
  if (unprotected.length === 0) {
    console.log(
      `  ✓ every table is protected or exempt (${protectedCount} with RLS, ${
        liveTables.length - protectedCount
      } exempt)`,
    );
  } else {
    console.log(`  ✗ ${unprotected.length} table(s) have neither RLS nor an exemption:`);
    for (const name of unprotected) console.log(`      ${name}`);
    console.log("      → add a policy in src/db/schema/rls-tenant.ts, or an RLS_EXEMPTIONS entry");
  }

  const granted = auditPrivileges.map((p) => p.privilege_type).sort();
  const mutating = granted.filter((p) =>
    ["UPDATE", "DELETE", "TRUNCATE"].includes(p),
  );
  console.log(
    mutating.length === 0
      ? `  ✓ audit_events is append-only for ${APP_ROLE} (${granted.join(", ") || "no grants"})`
      : `  ✗ ${APP_ROLE} can still ${mutating.join("/")} audit_events`,
  );

  const failed =
    helpers.length < 2 ||
    roles.length < 2 ||
    roles.some((r) => r.rolsuper || r.rolbypassrls) ||
    unforced.length > 0 ||
    unprotected.length > 0 ||
    mutating.length > 0;

  console.log("──────────────────────────────────────────────────────────\n");
  return !failed;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl =
    process.env.NODE_ENV === "production"
      ? process.env.PROD_DATABASE_URL
      : process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "No database URL. Set DATABASE_URL (or PROD_DATABASE_URL in production).",
    );
  }

  // Revoking UPDATE and DELETE from the application role is not something to
  // discover having done by accident.
  if (process.env.NODE_ENV === "production" && !args.confirmProduction && !args.dryRun) {
    throw new Error(
      "Refusing to apply the security baseline to production without --confirm-production.",
    );
  }

  const allStatements = [
    ["helper functions", helperFunctions()],
    [`role ${APP_ROLE}`, createRole(APP_ROLE, process.env.ORAVANTI_APP_DB_PASSWORD)],
    [
      `role ${MAINTENANCE_ROLE}`,
      createRole(MAINTENANCE_ROLE, process.env.ORAVANTI_MAINTENANCE_DB_PASSWORD),
    ],
    ["force row level security", forceRlsOnCoveredTables],
    [`grants for ${APP_ROLE}`, appGrants()],
    [`grants for ${MAINTENANCE_ROLE}`, maintenanceGrants()],
  ] as const;

  // The functions must exist before the first policy migration; every statement
  // after them grants on tables that migration has not created yet. Ordering is
  // therefore load-bearing, and `--functions-only` is exactly the first entry.
  const statements = args.functionsOnly ? allStatements.slice(0, 1) : allStatements;

  if (args.dryRun) {
    console.log("-- DRY RUN: nothing below has been applied.\n");
    for (const [label, sqlText] of statements) {
      console.log(`-- ── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
      console.log(sqlText.trim());
      console.log();
    }
    return;
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: (n) => {
    // The DO blocks report each table they touch; that output is the log.
    if (n.message) console.log(`  ${n.message}`);
  } });

  try {
    for (const [label, sqlText] of statements) {
      console.log(`[baseline] ${label}`);
      await client.unsafe(sqlText);
    }

    if (args.functionsOnly) {
      // Nothing to verify yet — the roles and tables the verify pass reads do
      // not exist on a database this flag is meant for.
      console.log("[baseline] helper functions created — run migrations, then the full baseline");
      return;
    }

    const ok = await verify(client);
    if (!ok) {
      console.error("[baseline] applied, but verification found problems above");
      process.exitCode = 1;
      return;
    }
    console.log("[baseline] security baseline applied and verified");
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  console.error("[baseline] failed:", err);
  process.exit(1);
});
