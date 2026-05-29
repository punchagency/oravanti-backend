import { Request, Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
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
    res.status(200).json(result);
  });

  getFirmPracticeAreas = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search } = req.query;
    const result = await this.practiceAreasService.getFirmPracticeAreas(
      req.firmId!,
      { search: search as string | undefined },
    );
    res.status(200).json(result);
  });

  createSubscriptions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.createSubscriptions(
      req.firmId!,
      req.body,
    );
    res.status(201).json(result);
  });

  cancelSubscriptions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.cancelSubscriptions(
      req.firmId!,
      req.body,
    );
    res.status(200).json(result);
  });
}
