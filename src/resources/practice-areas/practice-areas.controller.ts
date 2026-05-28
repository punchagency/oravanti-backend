import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { PracticeAreasService } from "./practice-areas.service";

export class PracticeAreasController {
  private practiceAreasService: PracticeAreasService;

  constructor(practiceAreasService: PracticeAreasService) {
    this.practiceAreasService = practiceAreasService;
  }

  getAllPracticeAreas = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search } = req.query;
    const result = await this.practiceAreasService.getAllPracticeAreas(
      req.firmId!,
      { search: search as string | undefined },
    );
    res.status(200).json(result);
  });

  getPracticeAreaById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.getPracticeAreaById(
      req.params.id as string,
      req.firmId!,
    );

    if (!result) {
      throw new NotFoundError("Practice area not found");
    }

    res.status(200).json(result);
  });

  createPracticeArea = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.createPracticeArea(
      req.firmId!,
      req.body,
    );
    res.status(201).json(result);
  });

  updatePracticeArea = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.practiceAreasService.updatePracticeArea(
      req.params.id as string,
      req.firmId!,
      req.body,
    );

    if (!result) {
      throw new NotFoundError("Practice area not found");
    }

    res.status(200).json(result);
  });

  deletePracticeArea = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.practiceAreasService.deletePracticeArea(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Practice area deleted" });
  });
}
