import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { logPermissionChange } from "../permission-audit-log/permission-audit-log.service";
import * as gatesService from "./certification-gates.service";

export const getCertificationGates = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await gatesService.getCertificationGates(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateCertificationGates = async (
  req: AuthRequest,
  res: Response,
) => {
  const { gates } = req.body;

  if (!Array.isArray(gates) || gates.length === 0) {
    throw new BadRequestError("gates array is required");
  }

  try {
    await gatesService.updateCertificationGates(req.firmId!, gates);
    logPermissionChange(
      "Modified paralegal certification requirements",
      req.userId!,
      req.firmId!,
    ).catch(() => {});
    res.status(200).json({ message: "Certification gates updated" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getActivationRequirements = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await gatesService.getActivationRequirements(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateActivationRequirements = async (
  req: AuthRequest,
  res: Response,
) => {
  const { certificationCodes } = req.body;

  if (!Array.isArray(certificationCodes)) {
    throw new BadRequestError("certificationCodes array is required");
  }

  try {
    const result = await gatesService.updateActivationRequirements(
      req.firmId!,
      certificationCodes,
    );
    logPermissionChange(
      "Updated paralegal activation requirements",
      req.userId!,
      req.firmId!,
    ).catch(() => {});
    res.status(200).json({
      message: `Activation requirements updated. ${result.updated} paralegal(s) re-evaluated.`,
    });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
