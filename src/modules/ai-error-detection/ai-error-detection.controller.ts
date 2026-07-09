import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { AIErrorDetectionService } from "./ai-error-detection.service";

export class AIErrorDetectionController {
  private aiService: AIErrorDetectionService;

  constructor(aiService: AIErrorDetectionService) {
    this.aiService = aiService;
  }

  getStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getStats(req.organizationId!);
    sendSuccess(res, result, "Error detection stats retrieved successfully");
  });

  getAllFlags = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { severity, status } = req.query;
    const result = await this.aiService.getAllFlags(req.organizationId!, {
      severity: severity as string,
      status: status as string,
    });
    sendSuccess(res, result, "Flags retrieved successfully");
  });

  getFlagById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getFlagById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    sendSuccess(res, result, "Flag retrieved successfully");
  });

  updateFlagStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { status } = req.body;

    const result = await this.aiService.updateFlagStatus(
      req.params.id as string,
      req.organizationId!,
      status,
      req.adminId,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    sendSuccess(res, result, "Flag status updated successfully");
  });

  createFlag = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.createFlag(req.organizationId!, req.body);
    sendSuccess(res, result, "Flag created successfully", 201);
  });

  getSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.getSystemConfig(req.organizationId!);
    sendSuccess(res, result, "System config retrieved successfully");
  });

  updateSystemConfig = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.aiService.updateSystemConfig(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "System config updated successfully");
  });
}
