import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as aiService from "./ai-error-detection.service";

export const getStats = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getStats(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getAllFlags = async (req: AuthRequest, res: Response) => {
  const { severity, status } = req.query;
  try {
    const result = await aiService.getAllFlags(req.firmId!, {
      severity: severity as string,
      status: status as string,
    });
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getFlagById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getFlagById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateFlagStatus = async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  if (!status) {
    throw new BadRequestError("status is required");
  }

  try {
    const result = await aiService.updateFlagStatus(
      req.params.id as string,
      req.firmId!,
      status,
      req.adminId,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const createFlag = async (req: AuthRequest, res: Response) => {
  const { clientId, caseId, title, description, severity } = req.body;
  if (!clientId || !caseId || !title || !description || !severity) {
    throw new BadRequestError(
      "clientId, caseId, title, description and severity are required",
    );
  }

  try {
    const result = await aiService.createFlag(req.firmId!, req.body);
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const getSystemConfig = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getSystemConfig(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateSystemConfig = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.updateSystemConfig(req.firmId!, req.body);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};
