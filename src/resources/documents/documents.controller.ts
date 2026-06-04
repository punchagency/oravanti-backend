import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { parsePaginationQuery } from "../../utils/pagination";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import * as documentsService from "./documents.service";

export class DocumentsController {
  private documentsService: documentsService.DocumentsService;

  constructor(documentsService: documentsService.DocumentsService) {
    this.documentsService = documentsService;
  }

  getAllDocuments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, category, caseId, status, page, limit } = req.query;
    const pagination = parsePaginationQuery({ page, limit });

    const result = await this.documentsService.getAllDocuments(req.organizationId!, {
      search: search as string,
      category: category as string,
      caseId: caseId as string,
      status: status as string,
      ...pagination,
    });

    res.status(200).json(result);
  });

  getDocumentStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getDocumentStats(req.organizationId!);
    res.status(200).json(result);
  });

  getDocumentById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getDocumentById(
      req.params.id as string,
      req.organizationId!,
      req.userId,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    res.status(200).json(result);
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

    res.status(201).json(result);
  });

  updateDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      throw new BadRequestError("File is required");
    }

    const result = await this.documentsService.updateDocument(
      req.params.id as string,
      req.organizationId!,
      {
        uploadedByUserId: req.userId!,
        fileBuffer: file.buffer,
        mimeType: file.mimetype,
        fileSize: file.size,
        originalFilename: file.originalname,
      },
    );

    res.status(201).json(result);
  });

  linkDocumentToCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.linkDocumentToCase(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      req.body.caseId,
    );

    res.status(201).json(result);
  });

  grantUserAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.grantUserAccess(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      {
        targetUserId: req.body.userId,
        permission: req.body.permission,
      },
    );

    res.status(201).json(result);
  });

  grantFirmAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.grantFirmAccess(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      {
        firmId: req.body.firmId,
        permission: req.body.permission,
      },
    );

    res.status(201).json(result);
  });

  revokeUserAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.revokeUserAccess(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      req.params.userId as string,
    );

    res.status(200).json(result);
  });

  revokeFirmAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.revokeFirmAccess(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      req.params.firmId as string,
    );

    res.status(200).json(result);
  });

  createTransfer = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.createTransfer(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      {
        toFirmId: req.body.toFirmId,
        toUserId: req.body.toUserId,
        permission: req.body.permission,
        message: req.body.message,
        revokeSenderAccess: req.body.revokeSenderAccess,
      },
    );

    res.status(201).json(result);
  });

  getTransfers = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getTransfers(req.organizationId!);
    res.status(200).json(result);
  });

  acceptTransfer = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.acceptTransfer(
      req.params.transferId as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
  });

  rejectTransfer = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.rejectTransfer(
      req.params.transferId as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
  });

  createExternalRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.createExternalRequest(
      req.organizationId!,
      req.userId!,
      {
        caseId: req.body.caseId,
        recipientEmail: req.body.recipientEmail,
        recipientName: req.body.recipientName,
        recipientFirmName: req.body.recipientFirmName,
        message: req.body.message,
        expiresAt: new Date(req.body.expiresAt),
      },
    );

    res.status(201).json(result);
  });

  getExternalRequests = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getExternalRequests(
      req.organizationId!,
    );
    res.status(200).json(result);
  });

  cancelExternalRequest = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.cancelExternalRequest(
      req.params.requestId as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
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

    res.status(201).json(result);
  });

  updateDocumentStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.updateDocumentStatus(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
      req.body.status,
    );

    if (!result) {
      throw new NotFoundError("Document not found");
    }

    res.status(200).json(result);
  });

  archiveDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.archiveDocument(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
  });

  restoreDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.restoreDocument(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
  });

  getDownloadUrl = asyncWrap(async (req: AuthRequest, res: Response) => {
    const url = await this.documentsService.getDownloadUrl(
      req.params.id as string,
      req.organizationId!,
      req.userId,
    );

    res.status(200).json({ url });
  });

  getActivityLogs = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.documentsService.getActivityLogs(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json(result);
  });

  deleteDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.documentsService.deleteDocument(
      req.params.id as string,
      req.organizationId!,
      req.userId!,
    );

    res.status(200).json({ message: "Document deleted" });
  });
}
