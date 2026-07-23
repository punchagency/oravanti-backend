import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
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
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  console.error("[test-db] setup failed:", err);
  process.exit(1);
});
