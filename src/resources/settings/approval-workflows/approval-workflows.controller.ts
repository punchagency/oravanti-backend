import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { ApprovalWorkflowsService } from "./approval-workflows.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError } from "../../../utils/error/app-error";

export class ApprovalWorkflowsController {
  private approvalWorkflowsService: ApprovalWorkflowsService;
  private auditLogService: PermissionAuditLogService;

  constructor(
    approvalWorkflowsService: ApprovalWorkflowsService,
    auditLogService: PermissionAuditLogService,
  ) {
    this.approvalWorkflowsService = approvalWorkflowsService;
    this.auditLogService = auditLogService;
  }

  getApprovalWorkflows = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.approvalWorkflowsService.getApprovalWorkflows(
        req.firmId!,
      );
      res.status(200).json(result);
    
  });

  updateApprovalWorkflows = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { workflows } = req.body;

    if (!Array.isArray(workflows) || workflows.length === 0) {
      throw new BadRequestError("workflows array is required");
    }

    
      await this.approvalWorkflowsService.updateApprovalWorkflows(
        req.firmId!,
        workflows,
      );

      const action =
        workflows.length === 1
          ? `Changed approval workflow for ${workflows[0].workflowType.replace(/_/g, " ")}`
          : "Updated approval workflow configuration";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.firmId!)
        .catch(() => {});

      res.status(200).json({ message: "Approval workflows updated" });
    
  });
}
