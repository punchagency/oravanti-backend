import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as gatesService from '../../services/settings/certification-gates.service';
import { logPermissionChange } from '../../services/settings/permission-audit-log.service';

export const getCertificationGates = async (req: AuthRequest, res: Response) => {
  try {
    const result = await gatesService.getCertificationGates(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateCertificationGates = async (req: AuthRequest, res: Response) => {
  const { gates } = req.body;

  if (!Array.isArray(gates) || gates.length === 0) {
    res.status(400).json({ message: 'gates array is required' });
    return;
  }

  try {
    await gatesService.updateCertificationGates(req.firmId!, gates);
    logPermissionChange('Modified paralegal certification requirements', req.userId!, req.firmId!).catch(() => {});
    res.status(200).json({ message: 'Certification gates updated' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getActivationRequirements = async (req: AuthRequest, res: Response) => {
  try {
    const result = await gatesService.getActivationRequirements(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateActivationRequirements = async (req: AuthRequest, res: Response) => {
  const { certificationCodes } = req.body;

  if (!Array.isArray(certificationCodes)) {
    res.status(400).json({ message: 'certificationCodes array is required' });
    return;
  }

  try {
    const result = await gatesService.updateActivationRequirements(req.firmId!, certificationCodes);
    logPermissionChange('Updated paralegal activation requirements', req.userId!, req.firmId!).catch(() => {});
    res.status(200).json({
      message: `Activation requirements updated. ${result.updated} paralegal(s) re-evaluated.`,
    });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
