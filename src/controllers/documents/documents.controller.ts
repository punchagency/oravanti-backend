import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as documentsService from '../../services/documents/documents.service';

export const getAllDocuments = async (req: AuthRequest, res: Response) => {
  const { search, category, clientId, caseId, status } = req.query;
  try {
    const result = await documentsService.getAllDocuments(req.firmId!, {
      search:   search   as string,
      category: category as string,
      clientId: clientId as string,
      caseId:   caseId   as string,
      status:   status   as string,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getDocumentStats = async (req: AuthRequest, res: Response) => {
  try {
    const result = await documentsService.getDocumentStats(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getDocumentById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await documentsService.getDocumentById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Document not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const uploadDocument = async (req: AuthRequest, res: Response) => {
  const file = req.file;
  if (!file) { res.status(400).json({ message: 'File is required' }); return; }

  const { clientId, caseId, name, category } = req.body;
  if (!clientId || !caseId || !name || !category) {
    res.status(400).json({ message: 'clientId, caseId, name and category are required' });
    return;
  }

  try {
    const result = await documentsService.uploadDocument(req.firmId!, {
      clientId,
      caseId,
      uploadedById:     req.adminId!,
      name,
      category,
      fileBuffer:       file.buffer,
      mimeType:         file.mimetype,
      fileSize:         file.size,
      originalFilename: file.originalname,
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateDocumentStatus = async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  if (!status) { res.status(400).json({ message: 'status is required' }); return; }

  try {
    const result = await documentsService.updateDocumentStatus(req.params.id as string, req.firmId!, status);
    if (!result) { res.status(404).json({ message: 'Document not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const getDownloadUrl = async (req: AuthRequest, res: Response) => {
  try {
    const url = await documentsService.getDownloadUrl(req.params.id as string, req.firmId!);
    res.status(200).json({ url });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const deleteDocument = async (req: AuthRequest, res: Response) => {
  try {
    await documentsService.deleteDocument(req.params.id as string, req.firmId!);
    res.status(200).json({ message: 'Document deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
