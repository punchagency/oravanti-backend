import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { AIErrorDetectionService } from "./ai-error-detection.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export class AIErrorDetectionController {
  private aiService: AIErrorDetectionService;

  constructor(aiService: AIErrorDetectionService) {
    this.aiService = aiService;
  }

  getStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getStats(req.firmId!);
    res.status(200).json(result);
  });

  getAllFlags = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { severity, status } = req.query;
    const result = await this.aiService.getAllFlags(req.firmId!, {
      severity: severity as string,
      status: status as string,
    });
    res.status(200).json(result);
  });

  getFlagById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getFlagById(
      req.params.id as string,
      req.firmId!,
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
      req.firmId!,
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

    const result = await this.aiService.createFlag(req.firmId!, req.body);
    res.status(201).json(result);
  });

  getSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getSystemConfig(req.firmId!);
    res.status(200).json(result);
  });

  updateSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.updateSystemConfig(
      req.firmId!,
      req.body,
    );
    res.status(200).json(result);
  });
}
