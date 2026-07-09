import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { ClientResponsivenessService } from "./client-responsiveness.service";

export class ClientResponsivenessController {
  private clientResponsivenessService: ClientResponsivenessService;

  constructor(clientResponsivenessService: ClientResponsivenessService) {
    this.clientResponsivenessService = clientResponsivenessService;
  }

  getStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const stats = await this.clientResponsivenessService.getStats(req.organizationId!);
    sendSuccess(res, stats, "Client responsiveness stats retrieved successfully");
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
      sendSuccess(res, result, "Client responsiveness data retrieved successfully");
    },
  );

  addRequests = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseId, items, requestedAt } = req.body;

    const result = await this.clientResponsivenessService.addRequests(
      req.params.clientId as string,
      req.organizationId!,
      { caseId, items, requestedAt },
    );
    sendSuccess(res, result, "Requests added successfully", 201);
  });

  fulfillRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientResponsivenessService.fulfillRequest(
      req.params.requestId as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Request not found");
    }
    sendSuccess(res, result, "Request fulfilled successfully");
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
      sendSuccess(res, result, "Termination letter data retrieved successfully");
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
    sendSuccess(res, result, "Report exported successfully");
  });
}
