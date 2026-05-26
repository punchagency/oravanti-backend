import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { logPermissionChange } from "../permission-audit-log/permission-audit-log.service";
import * as financialAccessService from "./financial-access.service";

export const getFinancialAccess = async (req: AuthRequest, res: Response) => {
  try {
    const result = await financialAccessService.getFinancialAccess(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateFinancialAccess = async (
  req: AuthRequest,
  res: Response,
) => {
  const { controls } = req.body;

  if (!Array.isArray(controls) || controls.length === 0) {
    throw new BadRequestError("controls array is required");
  }

  try {
    await financialAccessService.updateFinancialAccess(req.firmId!, controls);

    const action =
      controls.length === 1
        ? `Updated financial access for ${controls[0].role} role`
        : "Updated financial access controls";
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: "Financial access controls updated" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
