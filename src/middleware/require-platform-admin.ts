import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";

import { systemDb } from "../db/client";
import { platformAdmins } from "../db/schema/platform-admins";
import { AuthorizationError } from "../utils/error/app-error";
import { getRequestContext } from "./request-context";

/**
 * Gates the platform CRM: only Oravanti's own staff get past this.
 *
 * Mount it once, immediately after `requireAuth`, on the whole router —
 * `router.use(requireAuth, requirePlatformAdmin)` — for the same reason
 * `requireResource` exists: a route added later inherits the gate instead of
 * needing somebody to remember it.
 *
 * ─── Why membership is the entire check ─────────────────────────────────────
 *
 * There is no permission vocabulary here and no `requirePermission` call. The
 * firm side needs one because a firm has many roles with different reach; the
 * platform tier has one kind of operator, and a row in `platform_admins` says
 * so. A second kind can grow a column when there is a second kind.
 *
 * Deliberately reads `systemDb`. `platform_admins` carries no tenant column to
 * be scoped by, and this runs before any decision about what the request may
 * see — so a tenant connection is both unavailable and beside the point.
 *
 * Note what this does *not* do: it never calls `resolveActorContext`. A
 * platform request holds no `organizationId`, which is what leaves the `db`
 * Proxy pointed at `systemDb` and lets the CRM write the platform's own
 * catalogue rows. See the comment in `auth.middleware.ts`.
 */
export async function requirePlatformAdmin(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  const { userId } = getRequestContext();

  if (!userId) {
    throw new AuthorizationError("Platform access requires a signed-in user");
  }

  const [operator] = await systemDb
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);

  if (!operator) {
    // Deliberately the same message whether the caller is a firm user, a
    // client, or nobody at all. "You are not a platform admin" and "there is
    // no such thing as a platform admin" should be indistinguishable from
    // outside.
    throw new AuthorizationError("Not found");
  }

  next();
}
