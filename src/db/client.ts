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
  The system pool. Short queries only, never held across a request.

  Explicit `max` because the default is easy to outgrow silently. Postgres's own
  max_connections must cover this plus one connection per concurrent
  authenticated request (see createTenantDb) plus the worker process.
*/
const SYSTEM_POOL_MAX = Number(process.env.DATABASE_SYSTEM_POOL_MAX ?? 10);

const client = postgres(env.databaseUrl, { max: SYSTEM_POOL_MAX });

export const systemDb = drizzle(client, {
  logger: false,
});

export const closeDb = () => client.end();

// ── Tenant-scoped connection factory ─────────────────────────────────────────
// Opens a connection for one request, binds the RLS session variable(s) on it,
// and returns a drizzle instance scoped to that connection plus the release
// that closes it. Supports both org-scoped (staff) and user-scoped
// (client/contractor) RLS.
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
   * Closes the connection. Safe to call twice; the second call is a no-op.
   */
  release: () => Promise<void>;
};

/**
 * Binds a request's tenant identity to a connection of its own.
 *
 * ─── Why a dedicated client, and not a connection from a pool ───────────────
 *
 * This is one `postgres()` instance per authenticated request, which costs a
 * TCP connect, a TLS handshake and a Postgres authentication each time. That
 * cost is real and it is paid deliberately, because the two cheaper designs
 * both fail:
 *
 *   - **`pool.reserve()`** looks ideal — an already-open connection, held
 *     exclusively — but postgres.js returns a bare `Sql` handle from it, and
 *     drizzle cannot drive one. `drizzle()` writes its date parsers into
 *     `client.options.parsers`, which a reserved handle does not have, and
 *     `db.transaction()` calls `client.begin()`, which it also does not have.
 *     Both are absent by construction, not by version; only the top-level
 *     instance carries them. This was tried and reverted — the first failure
 *     broke every authenticated request, and the second broke every one that
 *     opened a transaction.
 *
 *   - **`SET LOCAL` inside a per-request transaction** isolates correctly but
 *     changes semantics well beyond RLS: a long request would pin a
 *     transaction open for its whole life, and every existing
 *     `db.transaction()` call site would silently become nested.
 *
 * ─── Why exclusivity is the requirement ─────────────────────────────────────
 *
 * `set_config(..., false)` sets a *session* GUC, which outlives the statement.
 * On a shared connection the next borrower would inherit the previous tenant's
 * organization id — the worst possible bug in this file. A connection nothing
 * else can reach cannot leak one tenant's identity into another's request.
 *
 * ─── The connection must be handed back ─────────────────────────────────────
 *
 * `release()` ends the client. It is not optional and it is not best-effort:
 * this used to return a bare drizzle instance with no way to close anything, so
 * every authenticated request leaked a connection until Postgres refused new
 * ones. Callers get `{ db, release }` precisely so the release cannot be
 * forgotten — see the `finish`/`close` handlers in requestContextMiddleware.
 */
export async function createTenantDb(
  organizationId: string | null,
  userId: string | null,
): Promise<TenantConnection> {
  const tenantClient = postgres(env.databaseUrl, { max: 1 });
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    try {
      // `end()` closes the connection outright, so there is no pooled session
      // left holding this tenant's GUCs and nothing to reset first.
      await tenantClient.end({ timeout: 5 });
    } catch {
      // Already gone, or refusing to close. Either way the socket is not going
      // back into service, and there is nothing further this can do.
    }
  };

  try {
    // `SET` does not accept bind parameters; `set_config()` does. Never
    // interpolate these values into the statement text.
    if (organizationId) {
      await tenantClient.unsafe(
        `SELECT set_config('app.current_organization_id', $1, false)`,
        [assertSafeId(organizationId, "organization id")],
      );
    }

    if (userId) {
      await tenantClient.unsafe(
        `SELECT set_config('app.current_user_id', $1, false)`,
        [assertSafeId(userId, "user id")],
      );
    }

    // Constructed inside the try: `drizzle()` can throw, and anything that
    // throws while a connection is open has to close it.
    return { db: drizzle(tenantClient, { logger: false }), release };
  } catch (err) {
    // A half-bound connection must never reach a handler: it would carry one
    // of the two identities and silently widen what the request can see.
    await release();
    throw err;
  }
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
