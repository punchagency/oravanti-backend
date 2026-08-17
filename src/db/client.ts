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
const client = postgres(env.databaseUrl);

export const systemDb = drizzle(client, {
  logger: false,
});

export const closeDb = () => client.end();

// ── Tenant-scoped connection factory ─────────────────────────────────────────
// Creates a dedicated single-connection client, binds the RLS session variable(s),
// and returns a drizzle instance scoped to that connection.
// Supports both org-scoped (staff) and user-scoped (client/contractor) RLS.
export async function createTenantDb(
  organizationId: string | null,
  userId: string | null,
) {
  const tenantClient = postgres(env.databaseUrl, { max: 1 });

  if (organizationId) {
    await tenantClient.unsafe(
      `SET app.current_organization_id = '${organizationId}'`,
    );
  }

  if (userId) {
    await tenantClient.unsafe(
      `SET app.current_user_id = '${userId}'`,
    );
  }

  return drizzle(tenantClient, { logger: false });
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
