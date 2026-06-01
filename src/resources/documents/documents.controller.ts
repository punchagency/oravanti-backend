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
    const { search, category, clientId, caseId, status, page, limit } =
      req.query;

    const pagination = parsePaginationQuery({ page, limit });

    const result = await this.documentsService.getAllDocuments(req.organizationId!, {
      search: search as string,
      category: category as string,
      clientId: clientId as string,
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

    const { clientId, caseId, name, category } = req.body;
    if (!clientId || !caseId || !name || !category) {
      throw new BadRequestError(
        "clientId, caseId, name and category are required",
      );
    }

    const result = await this.documentsService.uploadDocument(req.organizationId!, {
      clientId,
      caseId,
      uploadedById: req.staffId!,
      name,
      category,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalFilename: file.originalname,
    });
    res.status(201).json(result);
  });

  updateDocumentStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      throw new BadRequestError("status is required");
    }

    const result = await this.documentsService.updateDocumentStatus(
      req.params.id as string,
      req.organizationId!,
      status,
    );
    if (!result) {
      throw new NotFoundError("Document not found");
    }
    res.status(200).json(result);
  });

  getDownloadUrl = asyncWrap(async (req: AuthRequest, res: Response) => {
    const url = await this.documentsService.getDownloadUrl(
      req.params.id as string,
      req.organizationId!,
    );
    res.status(200).json({ url });
  });

  deleteDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.documentsService.deleteDocument(
      req.params.id as string,
      req.organizationId!,
    );
    res.status(200).json({ message: "Document deleted" });
  });
}
