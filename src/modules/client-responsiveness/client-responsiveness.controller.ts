import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { ClientResponsivenessService } from "./client-responsiveness.service";

export class ClientResponsivenessController {
  private clientResponsivenessService: ClientResponsivenessService;

  constructor(clientResponsivenessService: ClientResponsivenessService) {
    this.clientResponsivenessService = clientResponsivenessService;
  }

  getStats = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const stats = await this.clientResponsivenessService.getStats(organizationId!);
    sendSuccess(res, stats, "Client responsiveness stats retrieved successfully");
  });

  getAllClientResponsiveness = asyncWrap(
    async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
      const { filter, search } = req.query;
      const result =
        await this.clientResponsivenessService.getAllClientResponsiveness(
          organizationId!,
          {
            filter: filter as string,
            search: search as string,
          },
        );
      sendSuccess(res, result, "Client responsiveness data retrieved successfully");
    },
  );

  addRequests = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { caseId, items, requestedAt } = req.body;

    const result = await this.clientResponsivenessService.addRequests(
      req.params.clientId as string,
      organizationId!,
      { caseId, items, requestedAt },
    );
    sendSuccess(res, result, "Requests added successfully", 201);
  });

  fulfillRequest = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.clientResponsivenessService.fulfillRequest(
      req.params.requestId as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Request not found");
    }
    sendSuccess(res, result, "Request fulfilled successfully");
  });

  generateTerminationLetter = asyncWrap(
    async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
      const result =
        await this.clientResponsivenessService.getTerminationLetterData(
          req.params.clientId as string,
          organizationId!,
        );
      if (!result) {
        throw new NotFoundError("Client not found");
      }
      sendSuccess(res, result, "Termination letter data retrieved successfully");
    },
  );

  exportReport = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.clientResponsivenessService.exportClientReport(
      req.params.clientId as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    sendSuccess(res, result, "Report exported successfully");
  });
}
