import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as approvalWorkflowsService from '../../services/settings/approval-workflows.service';
import { logPermissionChange } from '../../services/settings/permission-audit-log.service';

export const getApprovalWorkflows = async (req: AuthRequest, res: Response) => {
  try {
    const result = await approvalWorkflowsService.getApprovalWorkflows(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateApprovalWorkflows = async (req: AuthRequest, res: Response) => {
  const { workflows } = req.body;

  if (!Array.isArray(workflows) || workflows.length === 0) {
    res.status(400).json({ message: 'workflows array is required' });
    return;
  }

  try {
    await approvalWorkflowsService.updateApprovalWorkflows(req.firmId!, workflows);

    const action = workflows.length === 1
      ? `Changed approval workflow for ${workflows[0].workflowType.replace(/_/g, ' ')}`
      : 'Updated approval workflow configuration';
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: 'Approval workflows updated' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
