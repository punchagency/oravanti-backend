import { AsyncLocalStorage } from "node:async_hooks";
import { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";

export interface RequestContext {
  ipAddress: string | null;
  userId: string | null;
  organizationId: string | null;
  staffId: string | null;
  rawUserDEK: Buffer | null;
  tenantDb: any | null;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

const createEmptyContext = (): RequestContext => ({
  ipAddress: null,
  userId: null,
  organizationId: null,
  staffId: null,
  rawUserDEK: null,
  tenantDb: null,
});

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")?.[0]?.trim() || req.socket.remoteAddress || null;
  requestContextStore.run({ ...createEmptyContext(), ipAddress: ip }, () => {
    res.on("finish", cleanupTenantContext);
    next();
  });
}

export function getRequestContext(): RequestContext {
  return requestContextStore.getStore() ?? createEmptyContext();
}

export function getStaffId(): string | null { return getRequestContext().staffId; }

export function setRequestContext(updates: Partial<Pick<RequestContext, "userId" | "organizationId" | "staffId" | "rawUserDEK">>) {
  const store = requestContextStore.getStore();
  if (store) {
    if (updates.userId !== undefined) store.userId = updates.userId;
    if (updates.organizationId !== undefined) store.organizationId = updates.organizationId;
    if (updates.staffId !== undefined) store.staffId = updates.staffId;
    if (updates.rawUserDEK !== undefined) store.rawUserDEK = updates.rawUserDEK;
  }
}

/**
 * Lazily initializes the tenant-scoped database connection.
 * Called eagerly by requireAuth after setting userId/organizationId.
 * Creates a dedicated connection, sets the RLS session variable(s), and creates
 * a drizzle instance bound to that connection.
 *
 * Supports both org-scoped (staff) and user-scoped (client/contractor) RLS:
 * - Staff with org: SET app.current_organization_id
 * - Client/contractor (no org): SET app.current_user_id
 * - Client/contractor with org: SET both
 */
export async function initializeTenantContext(): Promise<void> {
  const store = requestContextStore.getStore();
  if (!store || store.tenantDb) return;

  // Need at least one of org or user to create tenant context
  if (!store.organizationId && !store.userId) return;

  // Dynamic import to avoid circular dependency
  const { createTenantDb } = await import("../db/client");
  store.tenantDb = await createTenantDb(store.organizationId, store.userId);
}

/**
 * Cleans up the tenant-scoped connection when the request completes.
 */
async function cleanupTenantContext(): Promise<void> {
  const store = requestContextStore.getStore();
  if (store?.tenantDb) {
    try {
      // drizzle-orm postgres-js sessions have a .client property
      const client = store.tenantDb.session?.client;
      if (client && typeof client.end === "function") {
        await client.end();
      }
    } catch {
      // Connection cleanup is best-effort
    }
    store.tenantDb = null;
  }
}
