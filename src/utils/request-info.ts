import type { Request } from "express";
import { REDACTED, REDACT_KEY_SET } from "../lib/logging/config";

/**
 * Reading identifying and diagnostic detail off an HTTP request.
 *
 * App-wide rather than per-caller because more than one subsystem needs the
 * same answers and they must not disagree: the request context, the access
 * log, rate limiting and (Phase 3) the audit trail all record the caller's IP.
 * When each derived it separately, the context read `x-forwarded-for` by hand
 * while the access log used `req.ip`, so a request behind a proxy could be
 * attributed to two different addresses in two different records.
 */

/** Hard cap on a stored user agent. Attacker-controlled and unbounded. */
const MAX_USER_AGENT = 512;

/**
 * The client's address.
 *
 * `x-forwarded-for` is a list appended to by each proxy; the first entry is
 * the original client. It is only trustworthy because `trust proxy` is set to
 * exactly one hop in app.ts — with `true`, a client could prepend its own
 * value and forge this.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();

  return first || req.socket?.remoteAddress || null;
}

/** The user agent, truncated. */
export function userAgentOf(req: Request): string | null {
  const value = req.headers["user-agent"];
  const raw = Array.isArray(value) ? value[0] : value;

  return raw ? raw.slice(0, MAX_USER_AGENT) : null;
}

/**
 * The matched route pattern — `/cases/:id` rather than `/cases/7f3e0c1a`.
 *
 * Low cardinality, so it is the field to group and chart by. Absent when
 * nothing matched, which is itself the answer for a 404.
 *
 * `mountPath` must be supplied by the caller from the request context. Reading
 * `req.baseUrl` alone is not enough: express restores it to the outer value
 * once the router's stack unwinds, so by the time the response finishes a
 * request to `/cases` reports a bare `/`.
 */
export function routePattern(
  req: Request,
  mountPath?: string | null,
): string | undefined {
  const route = (req as Request & { route?: { path?: string } }).route;
  const base = req.baseUrl || mountPath || "";

  if (!route?.path) return base || undefined;

  const full = `${base}${route.path}`;
  // A router mounted at /cases with a handler on "/" yields "/cases/"; the
  // trailing slash is noise that would split one route into two in a chart.
  return full.length > 1 ? full.replace(/\/+$/, "") : full;
}

/**
 * The request path with any secret-bearing path parameter masked.
 *
 * `/invoice-payment/:token` is the case that forces this: the route is
 * unauthenticated and the token IS the credential, so recording the raw path
 * hands anyone with log access the ability to view and pay the invoice.
 *
 * Masking is driven by the route's own parameter names against the shared
 * redaction list, so a future `/reset/:token` is covered the day it is added
 * rather than the day someone remembers to come back here.
 */
export function safePath(req: Request): string {
  const raw = (req.originalUrl ?? "").split("?")[0];
  const params = (req.params ?? {}) as Record<string, string>;

  let masked = raw;
  for (const [name, value] of Object.entries(params)) {
    if (!value || typeof value !== "string") continue;
    if (!REDACT_KEY_SET.has(name.toLowerCase())) continue;
    masked = masked.split(value).join(REDACTED);
  }

  return masked;
}

/**
 * Query parameters, or undefined when there are none.
 *
 * Worth keeping: pagination, filters and search terms are most of what
 * distinguishes one request to a list endpoint from another, and without them
 * a slow or failing request cannot be reproduced. Sensitive values are removed
 * downstream by `deepRedact`, which runs over every logged field — so a key
 * added to REDACT_KEYS takes effect here with no change to this file.
 */
export function queryParams(req: Request): Record<string, unknown> | undefined {
  const query = req.query as Record<string, unknown> | undefined;
  if (!query || Object.keys(query).length === 0) return undefined;

  return query;
}
