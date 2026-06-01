import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { ClientResponsivenessService } from "./client-responsiveness.service";

export class ClientResponsivenessController {
  private clientResponsivenessService: ClientResponsivenessService;

  constructor(clientResponsivenessService: ClientResponsivenessService) {
    this.clientResponsivenessService = clientResponsivenessService;
  }

  getStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const stats = await this.clientResponsivenessService.getStats(req.organizationId!);
    res.status(200).json(stats);
  });

  getAllClientResponsiveness = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { filter, search } = req.query;
      const result =
        await this.clientResponsivenessService.getAllClientResponsiveness(
          req.organizationId!,
          {
            filter: filter as string,
            search: search as string,
          },
        );
      res.status(200).json(result);
    },
  );

  addRequests = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseId, items, requestedAt } = req.body;

    if (!caseId || !items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError("caseId and items[] are required");
    }

    const result = await this.clientResponsivenessService.addRequests(
      req.params.clientId as string,
      req.organizationId!,
      { caseId, items, requestedAt },
    );
    res.status(201).json(result);
  });

  fulfillRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientResponsivenessService.fulfillRequest(
      req.params.requestId as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Request not found");
    }
    res.status(200).json(result);
  });

  generateTerminationLetter = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const result =
        await this.clientResponsivenessService.getTerminationLetterData(
          req.params.clientId as string,
          req.organizationId!,
        );
      if (!result) {
        throw new NotFoundError("Client not found");
      }
      res.status(200).json(result);
    },
  );

  exportReport = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientResponsivenessService.exportClientReport(
      req.params.clientId as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    res.status(200).json(result);
  });
}
