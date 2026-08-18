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

  getTreeData = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { practiceAreaIds, depth } = req.query;

    const parsedDepth = Number(depth);
    const result = await this.practiceAreasService.getTreeData({
      organizationId,
      practiceAreaIds:
        typeof practiceAreaIds === "string" && practiceAreaIds.length > 0
          ? practiceAreaIds.split(",").map((id) => id.trim())
          : undefined,
      depth: Number.isFinite(parsedDepth) ? parsedDepth : undefined,
    });

    // `no-cache` means "revalidate every time", not "don't store": Express
    // already emits an ETag, so an unchanged taxonomy costs a 304 with no body
    // instead of re-sending the tree. Deliberately not `max-age`, so a firm
    // that subscribes to a new practice area sees it immediately. `private`
    // because the firm scoping above makes the response account-specific.
    res.set("Cache-Control", "private, no-cache");
    sendSuccess(res, result, "Tree data retrieved successfully");
  });
}
