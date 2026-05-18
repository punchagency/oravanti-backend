import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as accessControlService from '../../services/settings/access-control.service';
import { logPermissionChange } from '../../services/settings/permission-audit-log.service';

export const getRoleOverview = async (req: AuthRequest, res: Response) => {
  try {
    const result = await accessControlService.getRoleOverview(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getPermissions = async (req: AuthRequest, res: Response) => {
  try {
    const result = await accessControlService.getPermissions(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const savePermissions = async (req: AuthRequest, res: Response) => {
  const { permissions } = req.body;

  if (!Array.isArray(permissions) || permissions.length === 0) {
    res.status(400).json({ message: 'permissions array is required' });
    return;
  }

  try {
    await accessControlService.savePermissions(req.firmId!, permissions);

    const action = permissions.length === 1
      ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
      : 'Updated module permissions';
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: 'Permissions saved' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
