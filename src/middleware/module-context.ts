import type { RequestHandler } from "express";
import { refreshServiceLogger } from "../lib/logging/service-logger";
import { setRequestContext } from "./request-context";

/**
 * Records which API module a request entered, so every log line it produces
 * says so.
 *
 * Without this, a failure raised inside a shared service — the encryption
 * helpers, the event trail, the mailer — is indistinguishable whether it came
 * from the cases module or the leads one, and the access log alone cannot tell
 * you because `path` is the concrete URL rather than the owning subsystem.
 *
 * The mount path is captured here rather than read back later because express
 * restores `req.baseUrl` to the outer value once a router's stack unwinds. By
 * the time the response finishes it is "", which is why the access log was
 * reporting `route: "/"` for a request to `/cases`.
 */

/** "/practice-areas" → "practice-areas"; "/api/auth" → "api.auth". */
export function moduleNameFrom(mountPath: string): string {
  const trimmed = mountPath.replace(/^\/+|\/+$/g, "");
  return trimmed ? trimmed.replace(/\//g, ".") : "root";
}

export function tagModule(mountPath: string): RequestHandler {
  const module = moduleNameFrom(mountPath);

  return (_req, _res, next) => {
    setRequestContext({ module, mountPath });
    // The memoised child logger was built before the module was known; drop it
    // so subsequent lines carry it.
    refreshServiceLogger();
    next();
  };
}
