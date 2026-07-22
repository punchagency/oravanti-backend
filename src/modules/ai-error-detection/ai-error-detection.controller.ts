import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { AIErrorDetectionService } from "./ai-error-detection.service";

export class AIErrorDetectionController {
  private aiService: AIErrorDetectionService;

  constructor(aiService: AIErrorDetectionService) {
    this.aiService = aiService;
  }

  getStats = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.aiService.getStats(organizationId!);
    sendSuccess(res, result, "Error detection stats retrieved successfully");
  });

  getAllFlags = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { severity, status } = req.query;
    const result = await this.aiService.getAllFlags(organizationId!, {
      severity: severity as string,
      status: status as string,
    });
    sendSuccess(res, result, "Flags retrieved successfully");
  });

  getFlagById = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.aiService.getFlagById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    sendSuccess(res, result, "Flag retrieved successfully");
  });

  updateFlagStatus = asyncWrap(async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const { status } = req.body;

    const result = await this.aiService.updateFlagStatus(
      req.params.id as string,
      organizationId!,
      status,
      staffId,
    );
    if (!result) {
      throw new NotFoundError("Flag not found");
    }
    sendSuccess(res, result, "Flag status updated successfully");
  });

  createFlag = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.aiService.createFlag(organizationId!, req.body);
    sendSuccess(res, result, "Flag created successfully", 201);
  });

  getSystemConfig = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.aiService.getSystemConfig(organizationId!);
    sendSuccess(res, result, "System config retrieved successfully");
  });

  updateSystemConfig = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.aiService.updateSystemConfig(
      organizationId!,
      req.body,
    );
    sendSuccess(res, result, "System config updated successfully");
  });
}