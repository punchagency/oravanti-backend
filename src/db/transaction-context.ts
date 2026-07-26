import { AsyncLocalStorage } from "node:async_hooks";

// ── Transaction-scoped AsyncLocalStorage ─────────────────────────────────────
// When a Drizzle transaction callback is active, the `tx` object is stored
// here so the `db` Proxy in client.ts can automatically route queries through
// the transaction without callers having to pass `tx` explicitly.
//
// This eliminates the entire class of "forgot to pass tx" bugs where a
// function calls bare `db` inside a transaction and deadlocks on the
// max:1 connection pool.

const txStore = new AsyncLocalStorage<any>();

/** Returns the active transaction, or null if outside a transaction. */
export function getTx(): any | null {
  return txStore.getStore() ?? null;
}

/**
 * Runs `callback` inside a scoped AsyncLocalStorage context where `getTx()`
 * returns the provided Drizzle transaction handle. The context is automatically
 * cleaned up when the callback completes (or throws).
 */
export function runInTransaction<T>(tx: any, callback: () => Promise<T>): Promise<T> {
  return txStore.run(tx, callback);
}

/**
 * Middleware-style wrapper: opens a Drizzle transaction and sets the active tx
 * context so every `db.*` call inside `callback` automatically participates in
 * the transaction — no need to pass `tx` to downstream functions.
 *
 * Usage:
 *   import { withTransaction } from "../../db/transaction-context";
 *
 *   const result = await withTransaction(async () => {
 *     await db.insert(foo).values({...});
 *     await someService.doWork();  // internally uses db — automatically in tx
 *     return result;
 *   });
 */
export function withTransaction<T>(
  drizzleDb: { transaction: <R>(cb: (tx: any) => Promise<R>) => Promise<R> },
  callback: () => Promise<T>,
): Promise<T> {
  return drizzleDb.transaction(async (tx) => {
    return runInTransaction(tx, callback);
  });
}
