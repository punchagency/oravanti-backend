import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from './config/env';
import { runBackfills } from './db/backfills';

const client = postgres(env.databaseUrl, { max: 1 });
const db = drizzle(client);

async function main() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('Migrations applied successfully!');

  // Data corrections that cannot live in a migration, because migrations are
  // gitignored and regenerated per developer. See src/db/backfills.ts.
  console.log('Running backfills...');
  await runBackfills(db);
  await client.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
