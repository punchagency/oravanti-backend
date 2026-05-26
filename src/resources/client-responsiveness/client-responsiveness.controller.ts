import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as service from "./client-responsiveness.service";

export const getStats = async (req: AuthRequest, res: Response) => {
  try {
    const stats = await service.getStats(req.firmId!);
    res.status(200).json(stats);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getAllClientResponsiveness = async (
  req: AuthRequest,
  res: Response,
) => {
  const { filter, search } = req.query;
  try {
    const result = await service.getAllClientResponsiveness(req.firmId!, {
      filter: filter as string,
      search: search as string,
    });
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const addRequests = async (req: AuthRequest, res: Response) => {
  const { caseId, items, requestedAt } = req.body;

  if (!caseId || !items || !Array.isArray(items) || items.length === 0) {
    throw new BadRequestError("caseId and items[] are required");
  }

  try {
    const result = await service.addRequests(
      req.params.clientId as string,
      req.firmId!,
      { caseId, items, requestedAt },
    );
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const fulfillRequest = async (req: AuthRequest, res: Response) => {
  try {
    const result = await service.fulfillRequest(
      req.params.requestId as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Request not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const generateTerminationLetter = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await service.getTerminationLetterData(
      req.params.clientId as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const exportReport = async (req: AuthRequest, res: Response) => {
  try {
    const result = await service.exportClientReport(
      req.params.clientId as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
