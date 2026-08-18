import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";
import { clientIp, userAgentOf } from "../utils/request-info";
import { annotateSpan } from "../telemetry/span";

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
  /**
   * The API module handling the request — "cases", "leads", "organization".
   *
   * Bound onto every log line for the request, so a failure deep in a shared
   * service still says which part of the API was being used when it happened.
   * Set by tagModule() as the request enters a module's router.
   */
  module: string | null;
  /**
   * Where that module is mounted ("/cases").
   *
   * Kept because express restores `req.baseUrl` to the outer value once a
   * router's stack unwinds — by the time the response finishes, it is "" and
   * the route pattern cannot be rebuilt from the request alone.
   */
  mountPath: string | null;
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
  /**
   * Hands the tenant connection back to the pool and clears its RLS session
   * variables. Set alongside `tenantDb`; null whenever there is no reservation
   * to return.
   *
   * Kept as its own field rather than reaching into `tenantDb.session.client`
   * the way cleanup used to: that reached for `.end()`, which on a pooled
   * connection would close the underlying socket instead of releasing it.
   */
  releaseTenantDb: (() => Promise<void>) | null;
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
  module: null,
  mountPath: null,
  ipAddress: null,
  userAgent: null,
  userId: null,
  organizationId: null,
  staffId: null,
  actorType: "anonymous",
  actorName: null,
  rawUserDEK: null,
  tenantDb: null,
  releaseTenantDb: null,
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
  const requestId = resolveRequestId(req);

  // Echoed so a user hitting an error can quote the id in a support ticket,
  // and so a caller can correlate its own logs with ours.
  res.setHeader("x-request-id", requestId);

  const context: RequestContext = {
    ...createEmptyContext(),
    requestId,
    source: "http",
    // Shared with the access log so one request is never attributed to two
    // different addresses in two different records.
    ipAddress: clientIp(req),
    userAgent: userAgentOf(req),
  };

  requestContextStore.run(context, () => {
    // The span the HTTP instrumentation opened is already active here, so the
    // request id lands on it before any handler runs. That is the join between
    // a log line and a trace: both carry the same id, from the same place.
    annotateSpanFromContext(context);
    /*
      Both events, not just "finish".

      "finish" fires when the response is fully written. It does NOT fire when
      the client hangs up mid-response, when the socket errors, or when the
      request is aborted — and every one of those used to leak the request's
      database connection permanently. "close" fires in all of those cases and
      also after a normal finish, which is why cleanupTenantContext is
      idempotent.

      `context` is passed explicitly rather than read from the store inside the
      handler, and that is load-bearing. An EventEmitter listener runs in the
      async context active when `emit()` is called, NOT the one active when
      `.on()` registered it — Node does not snapshot the context for listeners.
      On a normal response the emit happens to originate inside the handler, so
      a lookup would work; on an aborted one, "close" is emitted from the
      socket's own teardown, outside this request's context, and the lookup
      returns undefined. The cleanup would then find nothing to release and the
      reserved connection would leak for the lifetime of the process.

      Aborts are not an edge case in development — StrictMode double-mounts,
      cancelled queries and HMR reloads all produce them — so this leaked the
      pool empty within a couple of dozen requests, after which every request
      blocked forever waiting for a connection that was never coming back.
    */
    const releaseTenantConnection = () => {
      void cleanupTenantContext(context);
    };
    res.on("finish", releaseTenantConnection);
    res.on("close", releaseTenantConnection);
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

/**
 * Copies the request's identity onto the active OpenTelemetry span.
 *
 * An explicit allowlist, not a spread of the context. `RequestContext` carries
 * `rawUserDEK` — a live encryption key — and `tenantDb`, a database handle;
 * handing the whole object to an attribute serialiser would put the key
 * material in the telemetry backend as a stringified Buffer. This is the same
 * class of bug as D3 in the logging layer, arriving through a different door,
 * so it is closed the same way: name the fields that may leave.
 *
 * Called wherever the context changes, so a span acquires the user and tenant
 * the moment authentication resolves them rather than only at the end.
 */
function annotateSpanFromContext(store: RequestContext): void {
  annotateSpan({
    requestId: store.requestId,
    source: store.source,
    ...(store.module ? { apiModule: store.module } : {}),
    ...(store.userId ? { userId: store.userId } : {}),
    ...(store.organizationId ? { orgId: store.organizationId } : {}),
    ...(store.staffId ? { staffId: store.staffId } : {}),
    ...(store.actorType !== "anonymous" ? { actorType: store.actorType } : {}),
  });
}

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
      | "module"
      | "mountPath"
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
    if (updates.module !== undefined) store.module = updates.module;
    if (updates.mountPath !== undefined) store.mountPath = updates.mountPath;

    annotateSpanFromContext(store);
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
  const tenant = await createTenantDb(store.organizationId, store.userId);
  store.tenantDb = tenant.db;
  store.releaseTenantDb = tenant.release;
}

/**
 * Returns the tenant-scoped connection to the pool when the request ends.
 *
 * Bound to both `finish` and `close` (see requestContextMiddleware). Idempotent
 * because both can fire for the same request, and because `release()` itself
 * guards against a second call.
 *
 * Takes the context as an argument on purpose — it must not read the store,
 * because it runs from an event listener where the request's async context may
 * no longer be active. See the comment at the registration site.
 */
async function cleanupTenantContext(store: RequestContext): Promise<void> {
  if (!store.releaseTenantDb) return;

  const release = store.releaseTenantDb;
  // Cleared first, so a second event finds nothing to do even if the release
  // below is still in flight.
  store.releaseTenantDb = null;
  store.tenantDb = null;

  try {
    await release();
  } catch {
    // Best effort. A connection that cannot be reset is closed rather than
    // returned to the pool, which release() already handles.
  }
}
