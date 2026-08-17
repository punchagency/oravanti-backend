import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { sql } from "drizzle-orm";

/** Mirrors the user.accountType enum, plus the two non-human origins. */
export type ActorType = "staff" | "client" | "contractor" | "system" | "anonymous";

/** Where the work came from. Everything that is not an HTTP request has no `req`. */
export type RequestSource = "http" | "queue" | "webhook" | "cli" | "system";

export interface RequestContext {
  /**
   * Ties an HTTP access log, every diagnostic line, and (from Phase 3) every
   * audit row to one user action. Always set — there is no valid context
   * without one.
   */
  requestId: string;
  source: RequestSource;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string | null;
  organizationId: string | null;
  staffId: string | null;
  actorType: ActorType;
  /**
   * Snapshot of the actor's display name, resolved once per request in
   * resolveActorContext. Audit rows store it so history survives the staff
   * member being deleted — and resolving it here is what removes the
   * per-event SELECT the four actorNameFor() helpers each performed.
   */
  actorName: string | null;
  rawUserDEK: Buffer | null;
  tenantDb: any | null;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/**
 * Stable for the life of the process, and used only when code runs outside
 * any request context. Minting a fresh id per call would be worse than
 * useless: every unbound log line would look like its own request, and
 * grouping by requestId — the whole point — would silently stop working.
 */
const PROCESS_CONTEXT_ID = `process-${randomUUID()}`;

const createEmptyContext = (): RequestContext => ({
  requestId: PROCESS_CONTEXT_ID,
  source: "system",
  ipAddress: null,
  userAgent: null,
  userId: null,
  organizationId: null,
  staffId: null,
  actorType: "anonymous",
  actorName: null,
  rawUserDEK: null,
  tenantDb: null,
});

/**
 * An inbound x-request-id lets a caller correlate across services, but it is
 * attacker-controlled and lands in every log line this request produces.
 * Unbounded or newline-bearing input is a log-injection primitive, so anything
 * that is not a short opaque token is discarded in favour of a fresh id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(req: Request): string {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")?.[0]?.trim() || req.socket.remoteAddress || null;
  const requestId = resolveRequestId(req);

  // Echoed so a user hitting an error can quote the id in a support ticket,
  // and so a caller can correlate its own logs with ours.
  res.setHeader("x-request-id", requestId);

  const context: RequestContext = {
    ...createEmptyContext(),
    requestId,
    source: "http",
    ipAddress: ip,
    userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
  };

  requestContextStore.run(context, () => {
    res.on("finish", cleanupTenantContext);
    next();
  });
}

/**
 * Entry point for work that has no HTTP request: queue jobs, webhook
 * handlers, CLI commands, scheduled tasks.
 *
 * Without this, such code runs with no store at all and every consumer
 * silently falls back to an empty context — which is how the current audit
 * tables ended up with null actors and null IPs on rows written by workers.
 * Propagate the originating requestId through the job payload and pass it
 * here, and async work stays correlated with the request that queued it.
 */
export function runWithRequestContext<T>(
  overrides: Partial<RequestContext> & { source: RequestSource },
  fn: () => T,
): T {
  return requestContextStore.run(
    // A fresh id per unit of work, unless the caller passes the originating
    // request's id to keep async follow-on work correlated with it.
    { ...createEmptyContext(), requestId: randomUUID(), ...overrides },
    fn,
  );
}

export function getRequestId(): string {
  return getRequestContext().requestId;
}

export function getRequestContext(): RequestContext {
  return requestContextStore.getStore() ?? createEmptyContext();
}

export function getStaffId(): string | null { return getRequestContext().staffId; }

export function setRequestContext(
  updates: Partial<
    Pick<
      RequestContext,
      | "userId"
      | "organizationId"
      | "staffId"
      | "rawUserDEK"
      | "actorType"
      | "actorName"
    >
  >,
) {
  const store = requestContextStore.getStore();
  if (store) {
    if (updates.userId !== undefined) store.userId = updates.userId;
    if (updates.organizationId !== undefined) store.organizationId = updates.organizationId;
    if (updates.staffId !== undefined) store.staffId = updates.staffId;
    if (updates.rawUserDEK !== undefined) store.rawUserDEK = updates.rawUserDEK;
    if (updates.actorType !== undefined) store.actorType = updates.actorType;
    if (updates.actorName !== undefined) store.actorName = updates.actorName;
  }
}

/**
 * Wraps a middleware (e.g. multer) so the AsyncLocalStorage request context is
 * preserved when it resumes the chain. Multer calls next() from a stream event
 * callback, which runs OUTSIDE the request's ALS context, so downstream
 * handlers (controllers) would otherwise see an empty context (userId null).
 */
export function preserveRequestContext(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const store = requestContextStore.getStore();
    handler(req, res, (err?: unknown) => {
      if (store) {
        requestContextStore.run(store, () => next(err as any));
      } else {
        next(err as any);
      }
    });
  };
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
