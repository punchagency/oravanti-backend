import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as documentsService from "./documents.service";

export class DocumentsController {
  private documentsService: documentsService.DocumentsService;

  constructor(documentsService: documentsService.DocumentsService) {
    this.documentsService = documentsService;
  }

  getAllDocuments = async (req: AuthRequest, res: Response) => {
    const { search, category, clientId, caseId, status } = req.query;
    try {
      const result = await this.documentsService.getAllDocuments(req.firmId!, {
        search: search as string,
        category: category as string,
        clientId: clientId as string,
        caseId: caseId as string,
        status: status as string,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getDocumentStats = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.documentsService.getDocumentStats(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getDocumentById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.documentsService.getDocumentById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Document not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  uploadDocument = async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ message: "File is required" });
      return;
    }

    const { clientId, caseId, name, category } = req.body;
    if (!clientId || !caseId || !name || !category) {
      res
        .status(400)
        .json({ message: "clientId, caseId, name and category are required" });
      return;
    }

    try {
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
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateDocumentStatus = async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ message: "status is required" });
      return;
    }

    try {
      const result = await this.documentsService.updateDocumentStatus(
        req.params.id as string,
        req.firmId!,
        status,
      );
      if (!result) {
        res.status(404).json({ message: "Document not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  getDownloadUrl = async (req: AuthRequest, res: Response) => {
    try {
      const url = await this.documentsService.getDownloadUrl(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json({ url });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  deleteDocument = async (req: AuthRequest, res: Response) => {
    try {
      await this.documentsService.deleteDocument(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json({ message: "Document deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
