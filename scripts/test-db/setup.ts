import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { RLS_PROBE_PASSWORD, RLS_PROBE_USER } from "./rls-probe";
import { maskUrl, resolveTestDbTarget } from "./url";

/**
 * Idempotent test-database setup: creates the database if it is absent, then
 * applies the Drizzle migrations. Safe to re-run — the common case (database
 * already exists, migrations already applied) is a no-op.
 *
 * Note that `drizzle/migrations/` is gitignored, so this depends on the local
 * migration files being current (`npm run db:generate`).
 */
/**
 * The RLS policies in `src/db/schema/rls.ts` reference these two functions, but
 * nothing in the generated migrations creates them — see the header comment in
 * that file ("These functions must exist in the database before policies are
 * applied"). In the development database they were created out of band, so a
 * fresh database must define them here or the very first policy migration fails
 * with `function get_current_user_id() does not exist`.
 *
 * Definitions mirror the development database exactly.
 */
const RLS_FUNCTIONS = `
CREATE OR REPLACE FUNCTION public.get_current_organization_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::text;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::text;
$$;
`;

/**
 * A role that RLS actually applies to.
 *
 * Postgres skips row-level security entirely for superusers, for roles with
 * BYPASSRLS, and for a table's owner unless FORCE ROW LEVEL SECURITY is set.
 * `oravanti_admin` is all three, so policies are inert on the normal
 * connection — verified empirically, not assumed.
 *
 * The `07-rls` check connects as this role instead, which is the only way to
 * demonstrate that the policies do what they claim. It is created here rather
 * than by a migration because it is test infrastructure, not schema.
 */
const RLS_PROBE_ROLE = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_PROBE_USER}') THEN
    CREATE ROLE ${RLS_PROBE_USER} LOGIN PASSWORD '${RLS_PROBE_PASSWORD}';
  END IF;
END
$$;

ALTER ROLE ${RLS_PROBE_USER} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO ${RLS_PROBE_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_PROBE_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_PROBE_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RLS_PROBE_USER};
`;

const main = async () => {
  const { testUrl, adminUrl, dbName } = resolveTestDbTarget();

  const admin = postgres(adminUrl, { max: 1 });
  try {
    const existing = await admin`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;

    if (existing.length) {
      console.log(`[test-db] ${dbName} already exists`);
    } else {
      // Identifiers cannot be parameterised; dbName comes from local env and is
      // quoted here to keep it a single identifier regardless of content.
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[test-db] created ${dbName}`);
    }
  } finally {
    await admin.end();
  }

  const client = postgres(testUrl, { max: 1 });
  try {
    await client.unsafe(RLS_FUNCTIONS);
    console.log("[test-db] RLS helper functions ensured");

    console.log(`[test-db] applying migrations to ${maskUrl(testUrl)}`);
    await migrate(drizzle(client), { migrationsFolder: "./drizzle/migrations" });
    console.log("[test-db] migrations applied");

    // After migrations: the grants need the tables to exist.
    await client.unsafe(RLS_PROBE_ROLE);
    console.log(`[test-db] RLS probe role '${RLS_PROBE_USER}' ensured`);
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  console.error("[test-db] setup failed:", err);
  process.exit(1);
});
