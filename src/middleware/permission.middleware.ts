import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { ac, clientPermissions, contractorPermissions } from "../auth/permissions";
import { systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { resolveMemberGrants } from "../modules/shared/member-grants.service";
import { AuthorizationError } from "../utils/error/app-error";
import { getRequestContext } from "./request-context";

type Statement = typeof ac.statements;
type Resources = keyof Statement;
type Action<Resource extends Resources = Resources> =
  Statement[Resource][number];

type PermissionsInput = {
  [Resource in Resources]?: Action<Resource>[];
};

/**
 * Maps an HTTP method to the CRUD action it performs.
 *
 * This exists so a resource router can be gated once, at mount time, instead of
 * per route — a route added later inherits the gate rather than needing someone
 * to remember `requirePermission`. That omission is exactly how five mutating
 * `/cases` endpoints shipped ungated while the reads beside them were gated.
 */
const METHOD_ACTION = {
  GET: "read",
  HEAD: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
} as const;

type GuardedMethod = keyof typeof METHOD_ACTION;

/**
 * Gates every request on a router by the resource it operates on, deriving the
 * action from the HTTP method.
 *
 * Mount it once: `router.use(requireAuth, resolveActorContext, requireResource("cases"))`.
 *
 * Routes whose action does not follow from the method — a POST that only reads,
 * or one needing a narrower action like `record_payment` — should still declare
 * their own `requirePermission` and be mounted on a router without this guard.
 */
export function requireResource<Resource extends Resources>(resource: Resource) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const action = METHOD_ACTION[req.method as GuardedMethod];

    // An unmapped method (OPTIONS, TRACE) never reaches a handler here; refuse
    // rather than fall through ungated.
    if (!action) {
      throw new AuthorizationError(`Unsupported method ${req.method}`);
    }

    return requirePermission(resource, action as Action<Resource>)(
      req,
      res,
      next,
    );
  };
}

export function requirePermission(
  permissions: PermissionsInput,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
export function requirePermission<Resource extends Resources>(
  resource: Resource,
  action: Action<Resource> | Action<Resource>[],
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
export function requirePermission<Resource extends Resources>(
  resourceOrPermissions: Resource | PermissionsInput,
  action?: Action<Resource> | Action<Resource>[],
) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const { userId, organizationId } = getRequestContext();

    const permissions =
      typeof resourceOrPermissions === "string" && action !== undefined
        ? ({
            [resourceOrPermissions]: Array.isArray(action) ? action : [action],
          } as PermissionsInput)
        : (resourceOrPermissions as PermissionsInput);

    // Staff/firm_admin: check organization-based permissions via auth API
    if (organizationId) {
      const result = await auth.api.hasPermission({
        body: {
          organizationId,
          permissions: permissions as Record<string, string[]>,
        },
        headers: fromNodeHeaders(req.headers as Record<string, string>),
      });

      if (!result.success) {
        // better-auth's own `hasPermission` resolves only `member.role` —
        // it has no notion of this app's role groups. A member who only has
        // access via a group they were added to would otherwise 403 on
        // every request despite the UI (which reads `getMyGrants`, and does
        // know about groups) showing them as permitted. Re-check against
        // the group-aware grant resolution before actually denying.
        if (userId) {
          const grants = await resolveMemberGrants(
            userId,
            organizationId,
            req.headers as Record<string, string | string[] | undefined>,
          );
          const covered = Object.entries(permissions).every(([resource, actions]) =>
            (actions as string[]).every((action) => grants.has(`${resource}:${action}`)),
          );
          if (covered) return next();
        }

        const entries = Object.entries(permissions);
        const parts: string[] = [];
        for (const [resource, actions] of entries) {
          const formattedResource = resource.replace(/_/g, " ");
          const actionsList = (actions as string[])
            .map((a) => a.replace(/_/g, " "))
            .join(" or ");
          parts.push(`${actionsList} ${formattedResource}`);
        }
        const message = `You do not have permission to ${parts.join(", or ")}`;
        throw new AuthorizationError(message);
      }

      return next();
    }

    // Client/contractor: check static permission set
    if (userId) {
      const [userRecord] = await systemDb
        .select({ accountType: user.accountType })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      const accountType = userRecord?.accountType;
      const staticPermissions =
        accountType === "client"
          ? clientPermissions
          : accountType === "contractor"
            ? contractorPermissions
            : null;

      if (!staticPermissions) {
        throw new AuthorizationError("Access denied");
      }

      // Check if the requested permissions are in the static set
      for (const [resource, actions] of Object.entries(permissions)) {
        const allowed = staticPermissions[resource] ?? [];
        for (const action of actions) {
          if (!allowed.includes(action as string)) {
            const formattedResource = resource.replace(/_/g, " ");
            const formattedAction = (action as string).replace(/_/g, " ");
            throw new AuthorizationError(
              `You do not have permission to ${formattedAction} ${formattedResource}`,
            );
          }
        }
      }

      return next();
    }

    throw new AuthorizationError("Access denied");
  };
}

/**
 * Does the caller hold these permissions? Answers rather than refuses.
 *
 * `requirePermission` is a gate: it throws and the request ends. Some actions
 * instead need to *branch* on a permission the caller may reasonably not have —
 * cancelling a paid consultation is one, where anybody in intake may cancel but
 * only an owner or admin may send the money back, and the cancellation must
 * still go through either way.
 *
 * Returns false rather than throwing on an auth failure, so a caller written to
 * degrade cannot be turned into a 500 by an expected "no".
 */
export async function hasPermission(
  req: Request,
  permissions: PermissionsInput,
): Promise<boolean> {
  const { organizationId } = getRequestContext();
  if (!organizationId) return false;

  try {
    const result = await auth.api.hasPermission({
      body: {
        organizationId,
        permissions: permissions as Record<string, string[]>,
      },
      headers: fromNodeHeaders(req.headers as Record<string, string>),
    });
    return Boolean(result.success);
  } catch {
    return false;
  }
}
