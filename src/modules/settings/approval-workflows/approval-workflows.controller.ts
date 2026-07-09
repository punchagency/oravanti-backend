import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { ApprovalWorkflowsService } from "./approval-workflows.service";

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
      req.organizationId!,
    );
    sendSuccess(res, result, "Approval workflows retrieved successfully");
  });

  updateApprovalWorkflows = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { workflows } = req.body;

      await this.approvalWorkflowsService.updateApprovalWorkflows(
        req.organizationId!,
        workflows,
      );

      const action =
        workflows.length === 1
          ? `Changed approval workflow for ${workflows[0].workflowType.replace(/_/g, " ")}`
          : "Updated approval workflow configuration";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.organizationId!)
        .catch(() => {});

      sendSuccess(res, null, "Approval workflows updated");
    },
  );
}
