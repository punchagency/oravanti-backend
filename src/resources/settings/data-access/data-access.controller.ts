import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { logPermissionChange } from "../permission-audit-log/permission-audit-log.service";
import * as dataAccessService from "./data-access.service";

export const getDataAccessControls = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await dataAccessService.getDataAccessControls(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateDataAccessControls = async (
  req: AuthRequest,
  res: Response,
) => {
  const { controls } = req.body;

  if (!Array.isArray(controls) || controls.length === 0) {
    throw new BadRequestError("controls array is required");
  }

  try {
    await dataAccessService.updateDataAccessControls(req.firmId!, controls);

    const action =
      controls.length === 1
        ? `Updated ${controls[0].dataType.replace(/_/g, " ")} access for ${controls[0].role} role`
        : "Updated data access controls";
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: "Data access controls updated" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
