import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { systemDb } from "../db/client";
import { member } from "../db/schema/auth-schema";
import { AuthorizationError } from "../utils/error/app-error";
import { getRequestContext } from "./request-context";

/**
 * Creating, editing, deleting, or resetting a role or role group is
 * restricted to the owner and admin roles specifically — not to whatever a
 * firm has granted through the permission matrix itself via `ac:*`, since
 * that would let a firm hand a custom role the ability to grant itself
 * more access. Checks the member's actual role(s) directly, unlike
 * `requirePermission`, which resolves against grants. (Merely *viewing*
 * RBAC data is gated separately, on `ac:read` — see the two routers that
 * mount this.)
 */
export function requireOwnerOrAdmin() {
  return async (_req: Request, _res: Response, next: NextFunction) => {
    const { userId, organizationId } = getRequestContext();
    if (!userId || !organizationId) {
      throw new AuthorizationError("Access denied");
    }

    const [memberRecord] = await systemDb
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
      .limit(1);

    const roles = (memberRecord?.role ?? "").split(",").map((r) => r.trim());
    if (!roles.includes("owner") && !roles.includes("admin")) {
      throw new AuthorizationError("Only the super admin and admin roles can manage roles & permissions");
    }

    return next();
  };
}
