import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { CasesService } from "./cases.service";

export class CasesController {
  private casesService: CasesService;

  constructor(casesService: CasesService) {
    this.casesService = casesService;
  }

  generateCaseNumber = async (req: AuthRequest, res: Response) => {
    const { caseType } = req.query;
    if (!caseType) {
      res.status(400).json({ message: "caseType is required" });
      return;
    }

    try {
      const caseNumber = await this.casesService.generateCaseNumber(
        caseType as string,
        req.firmId!,
      );
      res.status(200).json({ caseNumber });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getAllCases = async (req: AuthRequest, res: Response) => {
    const { search, status, assigneeId, clientId } = req.query;
    try {
      const result = await this.casesService.getAllCases(req.firmId!, {
        search: search as string,
        status: status as string,
        assigneeId: assigneeId as string,
        clientId: clientId as string,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getCaseById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.casesService.getCaseById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Case not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  createCase = async (req: AuthRequest, res: Response) => {
    const { clientId, caseType, filingDate, description } = req.body;

    if (!clientId || !caseType || !filingDate || !description) {
      res.status(400).json({
        message: "clientId, caseType, filingDate and description are required",
      });
      return;
    }

    try {
      const result = await this.casesService.createCase(req.firmId!, req.body, {
        adminId: req.adminId,
        staffId: req.staffId,
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateCase = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.casesService.updateCase(
        req.params.id as string,
        req.firmId!,
        req.body,
      );
      if (!result) {
        res.status(404).json({ message: "Case not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  deleteCase = async (req: AuthRequest, res: Response) => {
    try {
      await this.casesService.deleteCase(req.params.id as string, req.firmId!);
      res.status(200).json({ message: "Case deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
