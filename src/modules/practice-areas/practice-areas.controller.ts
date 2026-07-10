import { Request, Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { PracticeAreasService } from "./practice-areas.service";

export class PracticeAreasController {
  private practiceAreasService: PracticeAreasService;

  constructor(practiceAreasService: PracticeAreasService) {
    this.practiceAreasService = practiceAreasService;
  }

  getAllPracticeAreas = asyncWrap(async (req: Request, res: Response) => {
    const { search } = req.query;
    const result = await this.practiceAreasService.getAllPracticeAreas({
      search: search as string | undefined,
    });
    sendSuccess(res, result, "Practice areas retrieved successfully");
  });

  getFirmPracticeAreas = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search } = req.query;
    const result = await this.practiceAreasService.getFirmPracticeAreas(
      req.organizationId!,
      { search: search as string | undefined },
    );
    sendSuccess(res, result, "Firm practice areas retrieved successfully");
  });

  createSubscriptions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.createSubscriptions(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Subscriptions created successfully", 201);
  });

  cancelSubscriptions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.cancelSubscriptions(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Subscriptions cancelled successfully");
  });

  getTreeData = asyncWrap(async (_req: Request, res: Response) => {
    const result = await this.practiceAreasService.getTreeData();
    sendSuccess(res, result, "Tree data retrieved successfully");
  });
}
