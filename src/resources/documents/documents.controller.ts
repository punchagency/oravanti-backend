import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as documentsService from "./documents.service";

export const getAllDocuments = async (req: AuthRequest, res: Response) => {
  const { search, category, clientId, caseId, status } = req.query;
  try {
    const result = await documentsService.getAllDocuments(req.firmId!, {
      search: search as string,
      category: category as string,
      clientId: clientId as string,
      caseId: caseId as string,
      status: status as string,
    });
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getDocumentStats = async (req: AuthRequest, res: Response) => {
  try {
    const result = await documentsService.getDocumentStats(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getDocumentById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await documentsService.getDocumentById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Document not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const uploadDocument = async (req: AuthRequest, res: Response) => {
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

  try {
    const result = await documentsService.uploadDocument(req.firmId!, {
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
    sendErrorResponse(res, error, 400);
  }
};

export const updateDocumentStatus = async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  if (!status) {
    throw new BadRequestError("status is required");
  }

  try {
    const result = await documentsService.updateDocumentStatus(
      req.params.id as string,
      req.firmId!,
      status,
    );
    if (!result) {
      throw new NotFoundError("Document not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const getDownloadUrl = async (req: AuthRequest, res: Response) => {
  try {
    const url = await documentsService.getDownloadUrl(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ url });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const deleteDocument = async (req: AuthRequest, res: Response) => {
  try {
    await documentsService.deleteDocument(req.params.id as string, req.firmId!);
    res.status(200).json({ message: "Document deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
