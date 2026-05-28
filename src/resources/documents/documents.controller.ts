import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as documentsService from "./documents.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export class DocumentsController {
  private documentsService: documentsService.DocumentsService;

  constructor(documentsService: documentsService.DocumentsService) {
    this.documentsService = documentsService;
  }

  getAllDocuments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, category, clientId, caseId, status } = req.query;
    
      const result = await this.documentsService.getAllDocuments(req.firmId!, {
        search: search as string,
        category: category as string,
        clientId: clientId as string,
        caseId: caseId as string,
        status: status as string,
      });
      res.status(200).json(result);
    
  });

  getDocumentStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.documentsService.getDocumentStats(req.firmId!);
      res.status(200).json(result);
    
  });

  getDocumentById = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.documentsService.getDocumentById(
        req.params.id as string,
        req.firmId!,
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
      throw new BadRequestError("clientId, caseId, name and category are required");
    }

    
      const result = await this.documentsService.uploadDocument(req.firmId!, {
        clientId,
        caseId,
        uploadedById: req.adminId!,
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
        req.firmId!,
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
        req.firmId!,
      );
      res.status(200).json({ url });
    
  });

  deleteDocument = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      await this.documentsService.deleteDocument(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json({ message: "Document deleted" });
    
  });
}
