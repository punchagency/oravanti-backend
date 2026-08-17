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

    const tableNames = tables.map((t) => `"${t.tablename}"`).join(", ");

    await sql.unsafe(`TRUNCATE TABLE ${tableNames} CASCADE`);

    console.log(`Cleared ${tables.length} tables.`);
  } finally {
    await sql.end();
  }
}

clearAll();
