import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as casesService from "./cases.service";

export const generateCaseNumber = async (req: AuthRequest, res: Response) => {
  const { caseType } = req.query;
  if (!caseType) {
    throw new BadRequestError("caseType is required");
  }

  try {
    const caseNumber = await casesService.generateCaseNumber(
      caseType as string,
      req.firmId!,
    );
    res.status(200).json({ caseNumber });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getAllCases = async (req: AuthRequest, res: Response) => {
  const { search, status, assigneeId, clientId } = req.query;
  try {
    const result = await casesService.getAllCases(req.firmId!, {
      search: search as string,
      status: status as string,
      assigneeId: assigneeId as string,
      clientId: clientId as string,
    });
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getCaseById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await casesService.getCaseById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const createCase = async (req: AuthRequest, res: Response) => {
  const { clientId, caseType, filingDate, description } = req.body;

  if (!clientId || !caseType || !filingDate || !description) {
    throw new BadRequestError(
      "clientId, caseType, filingDate and description are required",
    );
  }

  try {
    const result = await casesService.createCase(req.firmId!, req.body, {
      adminId: req.adminId,
      staffId: req.staffId,
    });
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const updateCase = async (req: AuthRequest, res: Response) => {
  try {
    const result = await casesService.updateCase(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const deleteCase = async (req: AuthRequest, res: Response) => {
  try {
    await casesService.deleteCase(req.params.id as string, req.firmId!);
    res.status(200).json({ message: "Case deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
