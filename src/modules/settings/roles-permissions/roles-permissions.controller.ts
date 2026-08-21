import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { RolesPermissionsService } from "./roles-permissions.service";

export class RolesPermissionsController {
  constructor(private readonly service: RolesPermissionsService) {}

  /**
   * Search / type-filter / pagination all happen server-side (`listRoles`).
   * Omitting `page`/`limit` returns the full filtered list — pickers that
   * need every role call it that way.
   */
  getRoles = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { q, type, page, limit } = req.query as Record<string, string | undefined>;
    const result = await this.service.listRoles(organizationId!, req.headers as any, {
      q,
      type,
      page: page !== undefined ? parseInt(page, 10) : undefined,
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
    });
    sendSuccess(res, result, "Roles retrieved successfully");
  });

  getRoleOptions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.listRoleOptions(organizationId!, req.headers as any);
    sendSuccess(res, result, "Role options retrieved successfully");
  });

  getMatrix = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.getMatrix(organizationId!, req.headers as any);
    sendSuccess(res, result, "Permissions matrix retrieved successfully");
  });

  createRole = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { role, permission, description, color } = req.body;
    if (!role || typeof role !== "string") {
      return res.status(400).json({ error: "role is required" });
    }
    const result = await this.service.createRole(
      organizationId!,
      { role, permission: permission ?? {}, description, color },
      req.headers as any,
    );
    sendSuccess(res, result, "Role created successfully");
  });

  updateRole = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { permission, label, description } = req.body;
    const result = await this.service.updateRole(
      organizationId!,
      req.params.roleName as string,
      permission ?? {},
      req.headers as any,
      label,
      description,
    );
    sendSuccess(res, result, "Role updated successfully");
  });

  resetRole = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.resetRole(
      organizationId!,
      req.params.roleName as string,
      req.headers as any,
    );
    sendSuccess(res, result, "Role reset to default");
  });

  setRoleColor = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { color } = req.body;
    if (!color || typeof color !== "string") {
      return res.status(400).json({ error: "color is required" });
    }
    const result = await this.service.setRoleColor(
      organizationId!,
      req.params.roleName as string,
      color,
    );
    sendSuccess(res, result, "Role color updated successfully");
  });

  deleteRole = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.deleteRole(
      organizationId!,
      req.params.roleName as string,
      req.headers as any,
    );
    sendSuccess(res, result, "Role deleted successfully");
  });

  getMyGrants = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, userId } = getRequestContext();
    if (!userId) {
      return sendSuccess(res, [], "No grants — not authenticated");
    }
    const result = await this.service.getMyGrants(
      userId,
      organizationId ?? null,
      req.headers as any,
    );
    sendSuccess(res, result, "Grants retrieved successfully");
  });
}
