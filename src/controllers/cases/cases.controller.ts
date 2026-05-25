import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as casesService from '../../services/cases/cases.service';

export const generateCaseNumber = async (req: AuthRequest, res: Response) => {
  const { caseType } = req.query;
  if (!caseType) { res.status(400).json({ message: 'caseType is required' }); return; }

  try {
    const caseNumber = await casesService.generateCaseNumber(caseType as string, req.firmId!);
    res.status(200).json({ caseNumber });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getAllCases = async (req: AuthRequest, res: Response) => {
  const { search, status, assigneeId, clientId } = req.query;
  try {
    const result = await casesService.getAllCases(req.firmId!, {
      search:     search     as string,
      status:     status     as string,
      assigneeId: assigneeId as string,
      clientId:   clientId   as string,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getCaseById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await casesService.getCaseById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Case not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const createCase = async (req: AuthRequest, res: Response) => {
  const { clientId, caseType, filingDate, description } = req.body;

  if (!clientId || !caseType || !filingDate || !description) {
    res.status(400).json({ message: 'clientId, caseType, filingDate and description are required' });
    return;
  }

  try {
    const result = await casesService.createCase(
      req.firmId!,
      req.body,
      { adminId: req.adminId, staffId: req.staffId },
    );
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateCase = async (req: AuthRequest, res: Response) => {
  try {
    const result = await casesService.updateCase(req.params.id as string, req.firmId!, req.body);
    if (!result) { res.status(404).json({ message: 'Case not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const deleteCase = async (req: AuthRequest, res: Response) => {
  try {
    await casesService.deleteCase(req.params.id as string, req.firmId!);
    res.status(200).json({ message: 'Case deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
