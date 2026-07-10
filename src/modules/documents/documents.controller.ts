import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { parsePaginationQuery } from "../../utils/pagination";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import * as documentsService from "./documents.service";

export class DocumentsController {
  private documentsService: documentsService.DocumentsService;

  constructor(documentsService: documentsService.DocumentsService) {
    this.documentsService = documentsService;
  }

  getAllDocuments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, category, caseId, status, page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });

    const result = await this.documentsService.getAllDocuments(req.userId!, {
      search: search as string,
      category: category as string,
      caseId: caseId as string,
      status: status as string,
      ...queryPagination,
    });

    const { data, pagination } = result;
    sendSuccess(res, data, "Documents retrieved successfully", 200, { pagination });
  });

  getDocumentStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getDocumentStats(req.userId!);
    sendSuccess(res, result, "Document stats retrieved successfully");
  });

  getDocumentById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getDocumentById(
      req.params.id as string,
      req.userId!,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    sendSuccess(res, result, "Document retrieved successfully");
  });

  uploadDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const { caseId, title, name, category } = req.body;

    const result = await this.documentsService.uploadDocument(req.organizationId!, {
      caseId,
      uploadedByUserId: req.userId!,
      title: title ?? name,
      category,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalFilename: file.originalname,
    });

    sendSuccess(res, result, "Document uploaded successfully", 201);
  });

  updateDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const result = await this.documentsService.updateDocument(
      req.params.id as string,
      {
        uploadedByUserId: req.userId!,
        fileBuffer: file.buffer,
        mimeType: file.mimetype,
        fileSize: file.size,
        originalFilename: file.originalname,
      },
    );

    sendSuccess(res, result, "Document updated successfully", 201);
  });

  linkDocumentToCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.linkDocumentToCase(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      req.body.caseId,
    );

    sendSuccess(res, result, "Document linked to case successfully", 201);
  });

  grantUserAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.grantUserAccess(
      req.params.id as string,
      req.userId!,
      {
        targetUserId: req.body.userId,
        permission: req.body.permission,
      },
    );

    sendSuccess(res, result, "User access granted successfully", 201);
  });

  revokeUserAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.revokeUserAccess(
      req.params.id as string,
      req.userId!,
      req.params.userId as string,
    );

    sendSuccess(res, result, "User access revoked successfully");
  });

  createExternalRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.createExternalRequest(
      req.organizationId!,
      req.userId!,
      {
        caseId: req.body.caseId,
        recipientEmail: req.body.recipientEmail,
        recipientName: req.body.recipientName,
        message: req.body.message,
        expiresAt: new Date(req.body.expiresAt),
      },
    );

    sendSuccess(res, result, "External request created successfully", 201);
  });

  getExternalRequests = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getExternalRequests(
      req.userId!,
    );
    sendSuccess(res, result, "External requests retrieved successfully");
  });

  cancelExternalRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.cancelExternalRequest(
      req.params.requestId as string,
      req.userId!,
    );

    sendSuccess(res, result, "External request cancelled successfully");
  });

  submitExternalDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
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

  updateDocumentStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.updateDocumentStatus(
      req.params.id as string,
      req.userId!,
      req.body.status,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    sendSuccess(res, result, "Document status updated successfully");
  });

  archiveDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.archiveDocument(
      req.params.id as string,
      req.userId!,
    );

    sendSuccess(res, result, "Document archived successfully");
  });

  restoreDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.restoreDocument(
      req.params.id as string,
      req.userId!,
    );

    sendSuccess(res, result, "Document restored successfully");
  });

  getDownloadUrl = asyncWrap(async (req: AuthRequest, res: Response) => {
    const url = await this.documentsService.getDownloadUrl(
      req.params.id as string,
      req.userId!,
    );

    sendSuccess(res, { url }, "Download URL generated successfully");
  });

  getActivityLogs = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getActivityLogs(
      req.params.id as string,
      req.userId!,
    );

    sendSuccess(res, result, "Activity logs retrieved successfully");
  });

  deleteDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.documentsService.deleteDocument(
      req.params.id as string,
      req.userId!,
    );

    sendSuccess(res, null, "Document deleted successfully");
  });
}
