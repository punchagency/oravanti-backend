import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Response } from "express";
import { auth } from "../auth";
import { ac } from "../auth/permissions";
import { AuthorizationError } from "../utils/error/app-error";
import type { AuthRequest } from "./auth.middleware";

type Statement = typeof ac.statements;
type Resources = keyof Statement;
type Action<Resource extends Resources = Resources> =
  Statement[Resource][number];

type PermissionsInput = {
  [Resource in Resources]?: Action<Resource>[];
};

export function requirePermission(
  permissions: PermissionsInput,
): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export function requirePermission<Resource extends Resources>(
  resource: Resource,
  action: Action<Resource> | Action<Resource>[],
): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export function requirePermission<Resource extends Resources>(
  resourceOrPermissions: Resource | PermissionsInput,
  action?: Action<Resource> | Action<Resource>[],
) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.organizationId) {
      throw new AuthorizationError("Access denied");
    }

    const permissions =
      typeof resourceOrPermissions === "string" && action !== undefined
        ? ({
            [resourceOrPermissions]: Array.isArray(action) ? action : [action],
          } as PermissionsInput)
        : (resourceOrPermissions as PermissionsInput);

    const result = await auth.api.hasPermission({
      body: {
        organizationId: req.organizationId,
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

    next();
  };
}
