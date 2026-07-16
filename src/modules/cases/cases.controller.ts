import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import { DocumentsService } from "../documents/documents.service";
import { CasesService } from "./cases.service";

export class CasesController {
  private casesService: CasesService;
  private documentsService: DocumentsService;

  constructor(casesService: CasesService, documentsService: DocumentsService) {
    this.casesService = casesService;
    this.documentsService = documentsService;
  }

  generateCaseNumber = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { practiceAreaId, caseType } = req.query;

    const caseNumber = await this.casesService.generateCaseNumber(
      req.organizationId!,
      practiceAreaId as string,
      caseType as string,
    );
    sendSuccess(res, { caseNumber }, "Case number generated");
  });

  getAllCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const {
      search, status, assigneeId, clientId, practiceAreaId,
      practiceAreaName, caseTypeName, subcategoryName, assigneeName,
      page, limit,
    } = req.query;
    const result = await this.casesService.getAllCases(req.organizationId!, {
      search: search as string,
      status: status as "active" | "pending_review" | "on_hold" | "completed" | "cancelled" | undefined,
      assigneeId: assigneeId as string,
      clientId: clientId as string,
      practiceAreaId: practiceAreaId as string,
      practiceAreaName: practiceAreaName as string,
      caseTypeName: caseTypeName as string,
      subcategoryName: subcategoryName as string,
      assigneeName: assigneeName as string,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    const { data, pagination } = result;
    sendSuccess(res, data, "Cases retrieved successfully", 200, { pagination });
  });

  getCaseById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.getCaseById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    sendSuccess(res, result, "Case retrieved successfully");
  });

  createCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.casesService.createCase(req.organizationId!, req.body, {
      adminId: req.adminId,
      staffId: req.staffId,
    });
    sendSuccess(res, result, "Case created successfully", 201);
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
    sendSuccess(res, result, "Case updated successfully");
  });

  deleteCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.casesService.deleteCase(req.params.id as string, req.organizationId!);
    sendSuccess(res, null, "Case deleted successfully");
  });

  getCaseDocuments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });
    const result = await this.documentsService.getCaseDocuments(
      req.params.caseId as string,
      req.organizationId!,
      queryPagination.page,
      queryPagination.limit,
    );
    const { data, pagination } = result;
    sendSuccess(res, data, "Case documents retrieved successfully", 200, { pagination });
  });
}
