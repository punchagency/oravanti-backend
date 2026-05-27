import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { AIErrorDetectionService } from "./ai-error-detection.service";

export class AIErrorDetectionController {
  private aiService: AIErrorDetectionService;

  constructor(aiService: AIErrorDetectionService) {
    this.aiService = aiService;
  }

  getStats = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.aiService.getStats(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getAllFlags = async (req: AuthRequest, res: Response) => {
    const { severity, status } = req.query;
    try {
      const result = await this.aiService.getAllFlags(req.firmId!, {
        severity: severity as string,
        status: status as string,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getFlagById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.aiService.getFlagById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Flag not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateFlagStatus = async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ message: "status is required" });
      return;
    }

    try {
      const result = await this.aiService.updateFlagStatus(
        req.params.id as string,
        req.firmId!,
        status,
        req.adminId,
      );
      if (!result) {
        res.status(404).json({ message: "Flag not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  createFlag = async (req: AuthRequest, res: Response) => {
    const { clientId, caseId, title, description, severity } = req.body;
    if (!clientId || !caseId || !title || !description || !severity) {
      res.status(400).json({
        message:
          "clientId, caseId, title, description and severity are required",
      });
      return;
    }

    try {
      const result = await this.aiService.createFlag(req.firmId!, req.body);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  getSystemConfig = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.aiService.getSystemConfig(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateSystemConfig = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.aiService.updateSystemConfig(
        req.firmId!,
        req.body,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };
}
