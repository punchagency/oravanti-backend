import postgres from "postgres";
import { env } from "../config/env";

async function clearAll() {
  const sql = postgres(env.databaseUrl);

  try {
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;

    // An empty list would render as `TRUNCATE TABLE  CASCADE`, which Postgres
    // parses as a table literally named "cascade" — an error that says nothing
    // about the real problem, which is that this database has no schema yet.
    if (tables.length === 0) {
      console.log(
        "No tables in the public schema — nothing to clear. " +
          "Run `npm run db:migrate` (or `db:push`) first, and check DATABASE_URL " +
          "points at the database you mean.",
      );
      return;
    }

    const tableNames = tables.map((t) => `"${t.tablename}"`).join(", ");

    await sql.unsafe(`TRUNCATE TABLE ${tableNames} CASCADE`);

    console.log(`Cleared ${tables.length} tables.`);
  } finally {
    await sql.end();
  }
}

clearAll();
