import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { parsePaginationQuery } from "../../utils/pagination";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import * as documentsService from "./documents.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches the window the AI-review dispatcher gives a client to respond. */
const DEFAULT_REQUEST_EXPIRY_DAYS = 14;

export class DocumentsController {
  private documentsService: documentsService.DocumentsService;

  constructor(documentsService: documentsService.DocumentsService) {
    this.documentsService = documentsService;
  }

  getAllDocuments = asyncWrap(async (req: Request, res: Response) => {
    const { search, category, caseId, status, page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });

    const result = await this.documentsService.getAllDocuments(getRequestContext().userId!, {
      search: search as string,
      category: category as string,
      caseId: caseId as string,
      status: status as string,
      ...queryPagination,
    });

    const { data, pagination } = result;
    sendSuccess(res, data, "Documents retrieved successfully", 200, { pagination });
  });

  getDocumentStats = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.getDocumentStats(getRequestContext().userId!);
    sendSuccess(res, result, "Document stats retrieved successfully");
  });

  getDocumentById = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.getDocumentById(
      req.params.id as string,
      getRequestContext().userId!,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    sendSuccess(res, result, "Document retrieved successfully");
  });

  uploadDocument = asyncWrap(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const { caseId, title, name, category } = req.body;

    const result = await this.documentsService.uploadDocument(getRequestContext().organizationId!, {
      caseId,
      uploadedByUserId: getRequestContext().userId!,
      title: title ?? name,
      category,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalFilename: file.originalname,
    });

    sendSuccess(res, result, "Document uploaded successfully", 201);
  });

  updateDocument = asyncWrap(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const result = await this.documentsService.updateDocument(
      req.params.id as string,
      {
        uploadedByUserId: getRequestContext().userId!,
        fileBuffer: file.buffer,
        mimeType: file.mimetype,
        fileSize: file.size,
        originalFilename: file.originalname,
      },
    );

    sendSuccess(res, result, "Document updated successfully", 201);
  });

  linkDocumentToCase = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.linkDocumentToCase(
      req.params.id as string,
      getRequestContext().organizationId!,
      getRequestContext().userId!,
      req.body.caseId,
    );

    sendSuccess(res, result, "Document linked to case successfully", 201);
  });

  grantUserAccess = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.grantUserAccess(
      req.params.id as string,
      getRequestContext().userId!,
      {
        targetUserId: req.body.userId,
        permission: req.body.permission,
      },
    );

    sendSuccess(res, result, "User access granted successfully", 201);
  });

  revokeUserAccess = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.revokeUserAccess(
      req.params.id as string,
      getRequestContext().userId!,
      req.params.userId as string,
    );

    sendSuccess(res, result, "User access revoked successfully");
  });

  createExternalRequest = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.requestDocumentFromClient(
      getRequestContext().organizationId!,
      getRequestContext().userId!,
      {
        caseId: req.body.caseId,
        leadId: req.body.leadId,
        recipientEmail: req.body.recipientEmail,
        recipientName: req.body.recipientName,
        requestedLabel: req.body.requestedLabel,
        message: req.body.message,
        expiresAt: req.body.expiresAt
          ? new Date(req.body.expiresAt)
          : new Date(Date.now() + DEFAULT_REQUEST_EXPIRY_DAYS * DAY_MS),
      },
    );

    sendSuccess(res, result, "External request created successfully", 201);
  });

  getExternalRequests = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.getExternalRequests(
      getRequestContext().organizationId!,
      {
        caseId: req.query.caseId as string | undefined,
        leadId: req.query.leadId as string | undefined,
        status: req.query.status as never,
      },
    );
    sendSuccess(res, result, "External requests retrieved successfully");
  });

  cancelExternalRequest = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.cancelExternalRequest(
      req.params.requestId as string,
      getRequestContext().organizationId!,
      getRequestContext().userId!,
    );

    sendSuccess(res, result, "External request cancelled successfully");
  });

  submitExternalDocument = asyncWrap(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const result = await this.documentsService.submitExternalDocument(
      req.params.token as string,
      {
        uploadedByName: req.body.uploadedByName,
        uploadedByEmail: req.body.uploadedByEmail,
        title: req.body.title,
        fileBuffer: file.buffer,
        mimeType: file.mimetype,
        fileSize: file.size,
        originalFilename: file.originalname,
      },
    );

    sendSuccess(res, result, "External document submitted successfully", 201);
  });

  updateDocumentStatus = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.updateDocumentStatus(
      req.params.id as string,
      getRequestContext().userId!,
      req.body.status,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    sendSuccess(res, result, "Document status updated successfully");
  });

  archiveDocument = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.archiveDocument(
      req.params.id as string,
      getRequestContext().userId!,
    );

    sendSuccess(res, result, "Document archived successfully");
  });

  restoreDocument = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.restoreDocument(
      req.params.id as string,
      getRequestContext().userId!,
    );

    sendSuccess(res, result, "Document restored successfully");
  });

  getDownloadUrl = asyncWrap(async (req: Request, res: Response) => {
    const url = await this.documentsService.getDownloadUrl(
      req.params.id as string,
      getRequestContext().userId!,
    );

    sendSuccess(res, { url }, "Download URL generated successfully");
  });

  getActivityLogs = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.documentsService.getActivityLogs(
      req.params.id as string,
      getRequestContext().userId!,
    );

    sendSuccess(res, result, "Activity logs retrieved successfully");
  });

  deleteDocument = asyncWrap(async (req: Request, res: Response) => {
    await this.documentsService.deleteDocument(
      req.params.id as string,
      getRequestContext().userId!,
    );

    sendSuccess(res, null, "Document deleted successfully");
  });
}
