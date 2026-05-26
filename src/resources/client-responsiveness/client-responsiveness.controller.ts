import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as service from "./client-responsiveness.service";

export const getStats = async (req: AuthRequest, res: Response) => {
  try {
    const stats = await service.getStats(req.firmId!);
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
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
    res.status(500).json({ message: (error as Error).message });
  }
};

export const addRequests = async (req: AuthRequest, res: Response) => {
  const { caseId, items, requestedAt } = req.body;

  if (!caseId || !items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: "caseId and items[] are required" });
    return;
  }

  try {
    const result = await service.addRequests(
      req.params.clientId as string,
      req.firmId!,
      { caseId, items, requestedAt },
    );
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const fulfillRequest = async (req: AuthRequest, res: Response) => {
  try {
    const result = await service.fulfillRequest(
      req.params.requestId as string,
      req.firmId!,
    );
    if (!result) {
      res.status(404).json({ message: "Request not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
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
      res.status(404).json({ message: "Client not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const exportReport = async (req: AuthRequest, res: Response) => {
  try {
    const result = await service.exportClientReport(
      req.params.clientId as string,
      req.firmId!,
    );
    if (!result) {
      res.status(404).json({ message: "Client not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
