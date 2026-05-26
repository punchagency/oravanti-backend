import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { logPermissionChange } from "../permission-audit-log/permission-audit-log.service";
import * as approvalWorkflowsService from "./approval-workflows.service";

export const getApprovalWorkflows = async (req: AuthRequest, res: Response) => {
  try {
    const result = await approvalWorkflowsService.getApprovalWorkflows(
      req.firmId!,
    );
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateApprovalWorkflows = async (
  req: AuthRequest,
  res: Response,
) => {
  const { workflows } = req.body;

  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new BadRequestError("workflows array is required");
  }

  try {
    await approvalWorkflowsService.updateApprovalWorkflows(
      req.firmId!,
      workflows,
    );

    const action =
      workflows.length === 1
        ? `Changed approval workflow for ${workflows[0].workflowType.replace(/_/g, " ")}`
        : "Updated approval workflow configuration";
    logPermissionChange(action, req.userId!, req.firmId!).catch(() => {});

    res.status(200).json({ message: "Approval workflows updated" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
