import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { CasesService } from "./cases.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export class CasesController {
  private casesService: CasesService;

  constructor(casesService: CasesService) {
    this.casesService = casesService;
  }

  generateCaseNumber = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseType } = req.query;
    if (!caseType) {
      throw new BadRequestError("caseType is required");
    }

    const caseNumber = await this.casesService.generateCaseNumber(
      caseType as string,
      req.firmId!,
    );
    res.status(200).json({ caseNumber });
  });

  getAllCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, status, assigneeId, clientId } = req.query;
    const result = await this.casesService.getAllCases(req.firmId!, {
      search: search as string,
      status: status as string,
      assigneeId: assigneeId as string,
      clientId: clientId as string,
    });
    res.status(200).json(result);
  });

  getCaseById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.getCaseById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  });

  createCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { clientId, caseType, filingDate, description } = req.body;

    if (!clientId || !caseType || !filingDate || !description) {
      throw new BadRequestError(
        "clientId, caseType, filingDate and description are required",
      );
    }

    const result = await this.casesService.createCase(req.firmId!, req.body, {
      adminId: req.adminId,
      staffId: req.staffId,
    });
    res.status(201).json(result);
  });

  updateCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.updateCase(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  });

  deleteCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.casesService.deleteCase(req.params.id as string, req.firmId!);
    res.status(200).json({ message: "Case deleted" });
  });
}
