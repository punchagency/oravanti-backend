import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { logPermissionChange } from "../permission-audit-log/permission-audit-log.service";
import * as accessControlService from "./access-control.service";

export const getRoleOverview = async (req: AuthRequest, res: Response) => {
  try {
    const result = await accessControlService.getRoleOverview(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getPermissions = async (req: AuthRequest, res: Response) => {
  try {
    const result = await accessControlService.getPermissions(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const savePermissions = async (req: AuthRequest, res: Response) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new BadRequestError("permissions array is required");
  }

  try {
    await accessControlService.savePermissions(req.firmId!, permissions);

    const action =
      permissions.length === 1
        ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
        : "Updated module permissions";
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: "Permissions saved" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
