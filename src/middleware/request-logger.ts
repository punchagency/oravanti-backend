import type { NextFunction, Request, Response } from "express";
import { isLogLevelEnabled, logAt } from "../lib/logging/log";
import type { LogLevel } from "../lib/logging/types";
import { getRequestContext } from "./request-context";
import {
  clientIp,
  queryParams,
  routePattern,
  safePath,
  userAgentOf,
} from "../utils/request-info";

/**
 * One structured line per HTTP request, replacing morgan.
 *
 * Hand-written rather than pino-http because the correlation fields come from
 * AsyncLocalStorage, not from `req` — the same logger serves queue jobs and CLI
 * commands, which have no request to hang anything off. It is also driver-
 * agnostic: pino-http would have forced express-winston onto the other path and
 * made the two emit different access logs, which is exactly what LOG_DRIVER and
 * the conformance suite exist to prevent.
 *
 * Everything it reads off the request comes from utils/request-info, shared
 * with the request context so the two cannot describe the same caller
 * differently.
 */

/**
 * Paths kept out of the access log.
 *
 * A load balancer probes these every couple of seconds. At one line each they
 * would be the bulk of the log by volume while carrying no information, and
 * they drown out the requests worth reading. The paths are unprefixed —
 * /health, not /api/health — matching where app.ts actually mounts them.
 */
const SILENT_PATHS = new Set(["/health", "/health/live"]);

/**
 * Level follows the status so a filter set to `warn` still shows failures with
 * their route and duration. A 4xx storm — credential stuffing against
 * /api/auth, say — is then visible without turning on info.
 */
/**
 * Whether, and at what level, a request is logged on arrival as well as on
 * completion.
 *
 * Two lines per request is the shape the layered-logging blueprint asks for —
 * one saying a request arrived and where from, one saying how it ended — and
 * `info` is the default here for that reason. It is also, unavoidably, double
 * the access-log volume, and the arrival line carries nothing the completion
 * line does not except the fact that it happened at all.
 *
 * That fact is worth something: the completion line is written on `finish`, so
 * a request that hangs, deadlocks or takes the process down never produces
 * one. An arrival with no matching completion is the request that killed you,
 * and without this it leaves no trace whatsoever.
 *
 * `LOG_REQUEST_ENTRY=debug` keeps it available without the volume;
 * `LOG_REQUEST_ENTRY=off` removes it. Set one of those in production if the
 * log bill matters more than the hung-request case.
 */
function entryLevel(): LogLevel | null {
  const configured = process.env.LOG_REQUEST_ENTRY?.trim() || "info";
  if (configured === "off") return null;
  return configured === "debug" ? "debug" : "info";
}

function levelFor(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  if (SILENT_PATHS.has(req.path)) return next();

  // Monotonic, and unaffected by an NTP correction mid-request — Date.now()
  // can hand back a negative duration when the clock steps backwards.
  const startedAt = process.hrtime.bigint();

  // Read per request rather than memoised at import: a value captured at
  // module load cannot be changed by a test, and a setting nothing can
  // exercise is a setting nobody can trust.
  const arrival = entryLevel();

  if (arrival && isLogLevelEnabled(arrival)) {
    const inboundQuery = queryParams(req);
    const ip = clientIp(req);
    const origin = req.get("origin") ?? req.get("referer");

    logAt(
      arrival,
      "http.request_received",
      {
        method: req.method,
        path: safePath(req),
        ...(inboundQuery ? { query: inboundQuery } : {}),
        ip,
        ...(origin ? { origin } : {}),
        userAgent: userAgentOf(req),
        protocol: req.protocol,
        host: req.get("host"),
      },
      // Says where it came from in the message itself, so the origin is
      // visible without expanding the fields.
      `${req.method} ${safePath(req)} from ${origin ?? ip ?? "unknown"}`,
    );
  }

  // `finish` and `close` both fire on a normal response, and `close` alone
  // fires when the client hangs up mid-flight. Guarded so a request produces
  // exactly one line either way.
  let logged = false;

  const write = (aborted: boolean) => {
    if (logged) return;
    logged = true;

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const path = safePath(req);
    const route = routePattern(req, getRequestContext().mountPath);
    const query = queryParams(req);
    const length = res.getHeader("content-length");
    const referer = req.get("referer");

    // requestId, userId and orgId are bound from the request context by
    // getServiceLogger; `event` and `domain` are added by logAt. Neither is
    // repeated here — two sources for one field is two chances to disagree.
    logAt(
      levelFor(res.statusCode),
      "http.request",
      {
        method: req.method,
        path,
        ...(route ? { route } : {}),
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        ...(length === undefined ? {} : { bytes: Number(length) }),
        ...(query ? { query } : {}),
        ip: clientIp(req),
        userAgent: userAgentOf(req),
        ...(referer ? { referer } : {}),
        ...(aborted ? { aborted: true } : {}),
      },
      `${req.method} ${path} ${res.statusCode}`,
    );
  };

  res.on("finish", () => write(false));
  res.on("close", () => write(true));

  next();
}
