import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Data corrections that must run after a migration, and are NOT in one.
 *
 * `drizzle/migrations/` is gitignored — migrations are local-only and each
 * developer regenerates them from the schema. That works for DDL, which drizzle
 * derives, and not at all for data: a backfill hand-added to a generated file
 * is lost the moment somebody regenerates. So backfills live here, in version
 * control, and run on every `npm run db:migrate`.
 *
 * Every entry must therefore be idempotent — it will run again on the next
 * migrate, and the one after that. Write each so re-running is a no-op, and
 * scope it with a `WHERE` that stops matching once it has done its work.
 */

type Backfill = {
  name: string;
  /** Must be safe to run repeatedly. */
  run: (db: PostgresJsDatabase) => Promise<void>;
};

const BACKFILLS: Backfill[] = [
  {
    name: "settle-hand-recorded-payments",
    /**
     * `settled_at` arrived nullable, so every row that predates it reads as
     * money still in flight — which would make the case-opening gate treat a
     * firm's entire payment history as uncleared and refuse to open anything.
     *
     * Scoped to `provider IS NULL`, which is exactly the hand-recorded rows: a
     * member of staff entering a cheque is asserting the money is in the firm's
     * hands, and no webhook is ever coming to confirm it. Provider rows are
     * deliberately left null — their settlement is Confido's to report, and
     * assuming it here would defeat the point of the column.
     *
     * `created_at` rather than `now()` so the ledger records when the money
     * landed rather than when this happened to run.
     */
    run: async (db) => {
      await db.execute(sql`
        update invoice_payments
           set settled_at = created_at
         where settled_at is null
           and provider is null
      `);
    },
  },
];

export const runBackfills = async (db: PostgresJsDatabase): Promise<void> => {
  for (const backfill of BACKFILLS) {
    await backfill.run(db);
    console.log(`  backfill: ${backfill.name}`);
  }
};
