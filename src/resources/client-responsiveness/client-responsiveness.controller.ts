import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { ClientResponsivenessService } from "./client-responsiveness.service";

export class ClientResponsivenessController {
  private clientResponsivenessService: ClientResponsivenessService;

  constructor(clientResponsivenessService: ClientResponsivenessService) {
    this.clientResponsivenessService = clientResponsivenessService;
  }

  getStats = async (req: AuthRequest, res: Response) => {
    try {
      const stats = await this.clientResponsivenessService.getStats(
        req.firmId!,
      );
      res.status(200).json(stats);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getAllClientResponsiveness = async (req: AuthRequest, res: Response) => {
    const { filter, search } = req.query;
    try {
      const result =
        await this.clientResponsivenessService.getAllClientResponsiveness(
          req.firmId!,
          {
            filter: filter as string,
            search: search as string,
          },
        );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  addRequests = async (req: AuthRequest, res: Response) => {
    const { caseId, items, requestedAt } = req.body;

    if (!caseId || !items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ message: "caseId and items[] are required" });
      return;
    }

    try {
      const result = await this.clientResponsivenessService.addRequests(
        req.params.clientId as string,
        req.firmId!,
        { caseId, items, requestedAt },
      );
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  fulfillRequest = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientResponsivenessService.fulfillRequest(
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

  generateTerminationLetter = async (req: AuthRequest, res: Response) => {
    try {
      const result =
        await this.clientResponsivenessService.getTerminationLetterData(
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

  exportReport = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientResponsivenessService.exportClientReport(
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
}
