import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import { requestContextStore } from "../middleware/request-context";
import { getTx } from "./transaction-context";

// ── System-level connection pool (bypasses RLS) ─────────────────────────────
// Used for: module initialization, auth checks, DEK injection, and any query
// that runs outside an AsyncLocalStorage context (i.e. no request).
//
// ⚠️  IMPLICATIONS OF USING `systemDb` DIRECTLY:
//
//   1. BYPASSES ROW-LEVEL SECURITY — queries executed via `systemDb` see ALL
//      rows across ALL tenants. There is no organization_id or user_id filter
//      applied automatically. This is intentional for system-level operations
//      (auth, DEK, seeds) but DANGEROUS for business logic.
//
//   2. NEVER use `systemDb` for tenant-facing data queries (cases, leads,
//      documents, notes, etc.). Always use the `db` export instead, which
//      delegates to the tenant-scoped connection when an AsyncLocalStorage
//      context is active.
//
//   3. If you must use `systemDb` in a service, you MUST manually filter by
//      organization_id in the query to maintain tenant isolation. This is a
//      defense-in-depth measure — the application should never expose cross-
//      tenant data even if RLS is bypassed.
//
//   4. Auth-related queries (better-auth tables, user lookups, session checks)
//      are the primary legitimate use case. These tables are NOT covered by
//      RLS policies and require direct access.
//
//   5. The `db` Proxy falls back to `systemDb` when no AsyncLocalStorage
//      context exists (e.g., during module-level initialization or background
//      tasks). This is safe because those contexts don't have tenant scope.
//
// tl;dr — If you're importing `systemDb`, ask yourself: "Am I doing something
// that genuinely needs to see data across all tenants?" If the answer is no,
// use `db` instead.
/*
  One pool, shared by system queries and by every request's tenant connection.

  `max` is explicit because it is now load-bearing in a way it was not before.
  Each authenticated request reserves a connection from this pool for its
  duration (see createTenantDb), so this number is the ceiling on concurrent
  authenticated requests, not just on concurrent queries. Postgres's own
  max_connections must be at least this plus whatever the worker process and
  any admin session need.
*/
const client = postgres(env.databaseUrl, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 20),
});

export const systemDb = drizzle(client, {
  logger: false,
});

export const closeDb = () => client.end();

// ── Tenant-scoped connection factory ─────────────────────────────────────────
// Reserves a connection from the shared pool, binds the RLS session
// variable(s) on it, and returns a drizzle instance scoped to that connection.
// Supports both org-scoped (staff) and user-scoped (client/contractor) RLS.
/**
 * Session identifiers are the only thing standing between tenants, so they are
 * shape-checked before they are allowed near a connection. Better Auth issues
 * `text` ids (organization) and cuid/uuid-ish ids (user), so this is a
 * conservative character-class check rather than a strict UUID match — it
 * rejects quotes, semicolons and whitespace, which is what matters.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const assertSafeId = (value: string, label: string): string => {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Refusing to bind malformed ${label} to a tenant session`);
  }
  return value;
};

/** What a request holds for its lifetime, and must hand back when it ends. */
export type TenantConnection = {
  db: ReturnType<typeof drizzle>;
  /**
   * Clears the RLS session variables and returns the connection to the pool.
   * Safe to call twice; the second call is a no-op.
   */
  release: () => Promise<void>;
};

/**
 * Binds a request's tenant identity to a connection taken from the shared pool.
 *
 * ─── Why `reserve()` and not a new client ───────────────────────────────────
 *
 * This used to be `postgres(env.databaseUrl, { max: 1 })` — a brand new client
 * per authenticated request, which meant a fresh TCP connect, TLS handshake
 * and Postgres authentication on every call, and exhausted `max_connections`
 * under any real concurrency. `reserve()` takes an already-open connection out
 * of the pool and gives this request exclusive use of it, so the session
 * variables below cannot be seen by anyone else while it is held.
 *
 * Exclusivity is the whole requirement. `set_config(..., false)` sets a
 * *session* GUC, which outlives the statement; on a shared connection the next
 * borrower would inherit another tenant's organization id, which is the worst
 * possible bug in this file. A reserved connection is not shared, and
 * `release()` resets both variables before handing it back.
 *
 * The alternative the plan named — `SET LOCAL` inside a per-request
 * transaction — also isolates correctly, but wrapping every request in one
 * transaction changes semantics well beyond RLS: long requests would pin a
 * transaction open, and the ~34 existing `db.transaction()` call sites would
 * all become nested. Reservation buys the same isolation without touching
 * transaction boundaries.
 */
export async function createTenantDb(
  organizationId: string | null,
  userId: string | null,
): Promise<TenantConnection> {
  const reserved = await client.reserve();
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    try {
      // Reset before returning to the pool. Without this the next request to
      // borrow this connection starts life inside the previous tenant.
      await reserved.unsafe(
        `SELECT set_config('app.current_organization_id', NULL, false),
                set_config('app.current_user_id', NULL, false)`,
      );
    } catch {
      // A connection we cannot reset must not go back into rotation carrying
      // another tenant's identity. Closing it costs one reconnect; the pool
      // opens a replacement on demand.
      try {
        await reserved.release();
      } catch {
        /* already gone */
      }
      return;
    }
    reserved.release();
  };

  try {
    // `SET` does not accept bind parameters; `set_config()` does. Never
    // interpolate these values into the statement text.
    if (organizationId) {
      await reserved.unsafe(
        `SELECT set_config('app.current_organization_id', $1, false)`,
        [assertSafeId(organizationId, "organization id")],
      );
    }

    if (userId) {
      await reserved.unsafe(
        `SELECT set_config('app.current_user_id', $1, false)`,
        [assertSafeId(userId, "user id")],
      );
    }
  } catch (err) {
    // A half-bound connection must never reach a handler: it would carry one
    // of the two identities and silently widen what the request can see.
    await release();
    throw err;
  }

  return { db: drizzle(reserved, { logger: false }), release };
}

// ── Context-aware db export ──────────────────────────────────────────────────
// This Proxy delegates drizzle method calls (select, insert, update, delete, etc.)
// to the correct underlying drizzle instance using this priority:
//
//   1. Active transaction (getTx()) — when inside db.transaction() + runInTransaction()
//   2. Tenant context (tenantDb) — when an AsyncLocalStorage request context is active
//   3. System fallback (systemDb) — when no context exists
//
// Query builders capture the session at construction time via closures, so the
// builder must be created on the correct drizzle instance — we cannot swap the
// session after the fact.
//
// IMPORTANT: Services that must bypass RLS (user table lookups, auth checks,
// etc.) should import `systemDb` directly instead of `db`.
export const db = new Proxy(systemDb, {
  get(target, prop, receiver) {
    const originalValue = Reflect.get(target, prop, receiver);

    if (typeof originalValue === "function") {
      return function (...args: any[]) {
        // 1. Inside a transaction — all queries must go through tx
        const tx = getTx();
        if (tx && typeof tx[prop] === "function") {
          return tx[prop](...args);
        }

        // 2. Tenant context available — delegate to tenant-scoped connection
        const store = requestContextStore.getStore();
        if (store?.tenantDb && typeof store.tenantDb[prop] === "function") {
          return store.tenantDb[prop](...args);
        }

        // 3. Fallback: use systemDb
        return originalValue.apply(target, args);
      };
    }

    return originalValue;
  },
});
