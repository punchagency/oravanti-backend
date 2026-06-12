import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { CasesService } from "./cases.service";

export class CasesController {
  private casesService: CasesService;

  constructor(casesService: CasesService) {
    this.casesService = casesService;
  }

  generateCaseNumber = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { practiceAreaId, caseType } = req.query;

    const caseNumber = await this.casesService.generateCaseNumber(
      req.organizationId!,
      practiceAreaId as string,
      caseType as string,
    );
    res.status(200).json({ caseNumber });
  });

  getAllCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, status, assigneeId, clientId, practiceAreaId } = req.query;
    const result = await this.casesService.getAllCases(req.organizationId!, {
      search: search as string,
      status: status as string,
      assigneeId: assigneeId as string,
      clientId: clientId as string,
      practiceAreaId: practiceAreaId as string,
    });
    res.status(200).json(result);
  });

  getCaseById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.getCaseById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  });

  createCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.createCase(req.organizationId!, req.body, {
      adminId: req.adminId,
      staffId: req.staffId,
    });
    res.status(201).json(result);
  });

  updateCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.updateCase(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    res.status(200).json(result);
  });

  deleteCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.casesService.deleteCase(req.params.id as string, req.organizationId!);
    res.status(200).json({ message: "Case deleted" });
  });
}
