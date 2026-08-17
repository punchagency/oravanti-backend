import {
  requestContextStore,
  type RequestContext,
} from "../../middleware/request-context";
import { getLogger } from "./index";
import type { Logger } from "./types";

/**
 * The logger application code should use.
 *
 * Returns the root logger with the current request's correlation fields bound,
 * so every line written during a request carries the same `requestId` without
 * a single call site having to pass it. Outside a request — a queue job, a CLI
 * command, startup — it returns the root logger unadorned.
 *
 * This is the module that makes `req.log` unnecessary, and it is why nothing
 * is attached to `req`: a queue worker gets correlated logging on exactly the
 * same terms as an HTTP handler.
 *
 * Kept out of index.ts on purpose. index.ts is the driver contract and has no
 * application dependencies; importing it from a test or a script must not drag
 * in Express middleware.
 */

/**
 * One child logger per request rather than one per call. Keyed on the context
 * object itself, so it is collected with the request and cannot leak.
 */
const cache = new WeakMap<object, Logger>();

/**
 * The fields bound to every line written during a request. Separated from the
 * binding so the field set can be asserted directly, without standing up a
 * logger and parsing its output.
 *
 * Only populated fields are included: a line reading `"userId": null` on every
 * unauthenticated request is noise, and it makes a genuine null harder to spot.
 */
export function correlationFields(
  store: RequestContext,
): Record<string, unknown> {
  return {
    requestId: store.requestId,
    source: store.source,
    ...(store.module ? { apiModule: store.module } : {}),
    ...(store.userId ? { userId: store.userId } : {}),
    ...(store.organizationId ? { orgId: store.organizationId } : {}),
    ...(store.staffId ? { staffId: store.staffId } : {}),
    ...(store.actorType !== "anonymous" ? { actorType: store.actorType } : {}),
  };
}

export function getServiceLogger(): Logger {
  const store = requestContextStore.getStore();
  if (!store) return getLogger();

  const cached = cache.get(store);
  if (cached) return cached;

  const child = getLogger().child(correlationFields(store));

  cache.set(store, child);
  return child;
}

/**
 * Drops the memoised child for the current request.
 *
 * Correlation fields are populated across several middlewares — requireAuth
 * sets userId, resolveActorContext sets staffId and actorType — so anything
 * that logged before those ran holds a child bound to a thinner context.
 * Called once after auth resolution so later lines carry the full set.
 */
export function refreshServiceLogger(): void {
  const store = requestContextStore.getStore();
  if (store) cache.delete(store);
}
