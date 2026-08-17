import { NextFunction, Request, RequestHandler, Response } from "express";
import { LogEvent, isLogLevelEnabled, logDebug } from "../lib/logging/log";
import { getRequestContext } from "../middleware/request-context";
import { routePattern, safePath } from "./request-info";

/**
 * Wraps an async route handler so a rejected promise reaches the error
 * middleware instead of becoming an unhandled rejection, and so the controller
 * layer is logged without a line of logging in any controller.
 *
 * ── Why the controller log lives here ────────────────────────────────────────
 *
 * The layered-logging blueprint asks for a record of the handler being
 * entered. Writing that by hand would mean roughly five hundred near-identical
 * lines across 33 controllers, all of them saying the same thing in slightly
 * different words, all of them able to drift from the route they describe.
 * That is the "log fatigue" the same blueprint warns about at the middleware
 * layer, and the answer is the same: do it once, centrally.
 *
 * What this adds over the access log is the boundary. The access log says a
 * request arrived and how it ended; these two lines say the handler was
 * actually reached and returned — so a request that died in auth, in
 * validation, or in a rate limiter is distinguishable from one that reached
 * the controller, at a glance, without reading statuses.
 *
 * Both lines are debug: on a healthy request they are pure duplication of the
 * access log, and their value is entirely in the failing case.
 *
 * The other two things the blueprint wants at this layer are already central:
 * validation failures are reported by `validate.middleware` with every failing
 * field, and unexpected throws are logged once by `error.middleware` with the
 * stack. Neither belongs in a controller either.
 */
const asyncWrap = (callback: RequestHandler, name?: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const trace = isLogLevelEnabled("debug");

    if (trace) {
      logDebug(LogEvent.HTTP_HANDLER_STARTED, where(req, name));
    }

    try {
      await callback(req, res, next);

      if (trace) {
        logDebug(LogEvent.HTTP_HANDLER_COMPLETED, where(req, name));
      }
    } catch (error: any) {
      // Not logged here. error.middleware logs every failed request exactly
      // once, with the status it resolved to — logging again would double
      // every error and give the second copy no status to report.
      next(error);
    }
  };
};

function where(req: Request, name?: string) {
  const route = routePattern(req, getRequestContext().mountPath);

  return {
    ...(name ? { handler: name } : {}),
    method: req.method,
    path: safePath(req),
    ...(route ? { route } : {}),
  };
}

export default asyncWrap;
