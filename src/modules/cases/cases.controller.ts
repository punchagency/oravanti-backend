import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import { DocumentsService } from "../documents/documents.service";
import { logCaseView, getCaseActivityPaginated } from "./case-events.service";
import { CasesService } from "./cases.service";

export class CasesController {
  private casesService: CasesService;
  private documentsService: DocumentsService;

  constructor(casesService: CasesService, documentsService: DocumentsService) {
    this.casesService = casesService;
    this.documentsService = documentsService;
  }

  generateCaseNumber = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { practiceAreaId, caseType } = req.query;

    const caseNumber = await this.casesService.generateCaseNumber(
      organizationId!,
      practiceAreaId as string,
      caseType as string,
    );
    sendSuccess(res, { caseNumber }, "Case number generated");
  });

  getAllCases = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const {
      search, status, assigneeId, clientId, practiceAreaId,
      practiceAreaName, caseTypeName, subcategoryName, assigneeName,
      page, limit,
    } = req.query;
    const result = await this.casesService.getAllCases(organizationId!, {
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

  getCaseById = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.casesService.getCaseById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }

    // Log case view
    await logCaseView(
      organizationId!,
      req.params.id as string,
      staffId ?? undefined,
    );

    sendSuccess(res, result, "Case retrieved successfully");
  });

  createCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.casesService.createCase(organizationId!, req.body, {
      adminId: staffId ?? undefined,
      staffId: staffId ?? undefined,
    });
    sendSuccess(res, result, "Case created successfully", 201);
  });

  updateCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.casesService.updateCase(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId ?? undefined,
    );
    if (!result) {
      throw new NotFoundError("Case not found");
    }
    sendSuccess(res, result, "Case updated successfully");
  });

  deleteCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    await this.casesService.deleteCase(
      req.params.id as string,
      organizationId!,
      staffId ?? undefined,
    );
    sendSuccess(res, null, "Case deleted successfully");
  });

  getCaseDocuments = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });
    const result = await this.documentsService.getCaseDocuments(
      req.params.caseId as string,
      organizationId!,
      queryPagination.page,
      queryPagination.limit,
    );
    const { data, pagination } = result;
    sendSuccess(res, data, "Case documents retrieved successfully", 200, { pagination });
  });

  reassignTeam = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.id as string;
    const { teamId } = req.body;

    // Update case with new team
    await this.casesService.updateCase(caseId, organizationId!, {
      assignedTeamId: teamId,
      reassignmentDate: new Date(),
    }, staffId ?? undefined);

    sendSuccess(res, null, "Team reassigned successfully");
  });

  /**
   * One matter's activity feed.
   *
   * Gated on the `cases` resource by the router, not on `audit` — someone who
   * can open the matter can see what happened to it. The firm-wide trail at
   * `GET /audit-events` is the owner/admin surface, and this route used to be
   * shadowed by an ungated duplicate on the workflow router that was mounted
   * at the same path first.
   */
  getCaseAuditLog = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.id as string;
    const { page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });
    const result = await getCaseActivityPaginated({
      caseId,
      organizationId: organizationId!,
      page: queryPagination.page,
      limit: queryPagination.limit,
    });
    const { data, pagination } = result;
    sendSuccess(res, data, "Case audit log retrieved successfully", 200, { pagination });
  });
}
