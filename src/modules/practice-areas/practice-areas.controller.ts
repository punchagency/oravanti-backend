import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { PracticeAreasService } from "./practice-areas.service";

export class PracticeAreasController {
  private practiceAreasService: PracticeAreasService;

  constructor(practiceAreasService: PracticeAreasService) {
    this.practiceAreasService = practiceAreasService;
  }

  getAllPracticeAreas = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { search } = req.query;
    const result = await this.practiceAreasService.getAllPracticeAreas({
      search: search as string | undefined,
    });
    sendSuccess(res, result, "Practice areas retrieved successfully");
  });

  getFirmPracticeAreas = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { search } = req.query;
    const result = await this.practiceAreasService.getFirmPracticeAreas(
      organizationId!,
      { search: search as string | undefined },
    );
    sendSuccess(res, result, "Firm practice areas retrieved successfully");
  });

  createSubscriptions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.practiceAreasService.createSubscriptions(
      organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Subscriptions created successfully", 201);
  });

  cancelSubscriptions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.practiceAreasService.cancelSubscriptions(
      organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Subscriptions cancelled successfully");
  });

  getTreeData = asyncWrap(async (_req: Request, res: Response) => {
    const result = await this.practiceAreasService.getTreeData();
    sendSuccess(res, result, "Tree data retrieved successfully");
  });
}
