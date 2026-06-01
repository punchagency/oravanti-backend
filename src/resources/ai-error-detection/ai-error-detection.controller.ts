import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { AIErrorDetectionService } from "./ai-error-detection.service";

export class AIErrorDetectionController {
  private aiService: AIErrorDetectionService;

  constructor(aiService: AIErrorDetectionService) {
    this.aiService = aiService;
  }

  getStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getStats(req.organizationId!);
    res.status(200).json(result);
  });

  getAllFlags = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { severity, status } = req.query;
    const result = await this.aiService.getAllFlags(req.organizationId!, {
      severity: severity as string,
      status: status as string,
    });
    res.status(200).json(result);
  });

  getFlagById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getFlagById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    res.status(200).json(result);
  });

  updateFlagStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      throw new BadRequestError("status is required");
    }

    const result = await this.aiService.updateFlagStatus(
      req.params.id as string,
      req.organizationId!,
      status,
      req.adminId,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    res.status(200).json(result);
  });

  createFlag = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { clientId, caseId, title, description, severity } = req.body;
    if (!clientId || !caseId || !title || !description || !severity) {
      throw new BadRequestError(
        "clientId, caseId, title, description and severity are required",
      );
    }

    const result = await this.aiService.createFlag(req.organizationId!, req.body);
    res.status(201).json(result);
  });

  getSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getSystemConfig(req.organizationId!);
    res.status(200).json(result);
  });

  updateSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.updateSystemConfig(
      req.organizationId!,
      req.body,
    );
    res.status(200).json(result);
  });
}
