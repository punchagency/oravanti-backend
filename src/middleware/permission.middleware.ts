import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { auth } from "../auth";
import { ac, clientPermissions, contractorPermissions } from "../auth/permissions";
import { systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { AuthorizationError } from "../utils/error/app-error";
import { getRequestContext } from "./request-context";

type Statement = typeof ac.statements;
type Resources = keyof Statement;
type Action<Resource extends Resources = Resources> =
  Statement[Resource][number];

type PermissionsInput = {
  [Resource in Resources]?: Action<Resource>[];
};

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
