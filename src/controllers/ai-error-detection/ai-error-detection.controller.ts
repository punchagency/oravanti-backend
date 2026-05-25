import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as aiService from '../../services/ai-error-detection/ai-error-detection.service';

export const getStats = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getStats(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getAllFlags = async (req: AuthRequest, res: Response) => {
  const { severity, status } = req.query;
  try {
    const result = await aiService.getAllFlags(req.firmId!, {
      severity: severity as string,
      status:   status   as string,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getFlagById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getFlagById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Flag not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateFlagStatus = async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  if (!status) { res.status(400).json({ message: 'status is required' }); return; }

  try {
    const result = await aiService.updateFlagStatus(
      req.params.id as string,
      req.firmId!,
      status,
      req.adminId,
    );
    if (!result) { res.status(404).json({ message: 'Flag not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const createFlag = async (req: AuthRequest, res: Response) => {
  const { clientId, caseId, title, description, severity } = req.body;
  if (!clientId || !caseId || !title || !description || !severity) {
    res.status(400).json({ message: 'clientId, caseId, title, description and severity are required' });
    return;
  }

  try {
    const result = await aiService.createFlag(req.firmId!, req.body);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const getSystemConfig = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.getSystemConfig(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateSystemConfig = async (req: AuthRequest, res: Response) => {
  try {
    const result = await aiService.updateSystemConfig(req.firmId!, req.body);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};
