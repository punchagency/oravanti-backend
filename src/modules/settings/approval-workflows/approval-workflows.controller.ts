import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
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

  getApprovalWorkflows = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.approvalWorkflowsService.getApprovalWorkflows(
      organizationId!,
    );
    sendSuccess(res, result, "Approval workflows retrieved successfully");
  });

  updateApprovalWorkflows = asyncWrap(
    async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
      const { workflows } = req.body;

      await this.approvalWorkflowsService.updateApprovalWorkflows(
        organizationId!,
        workflows,
      );

      const action =
        workflows.length === 1
          ? `Changed approval workflow for ${workflows[0].workflowType.replace(/_/g, " ")}`
          : "Updated approval workflow configuration";
      this.auditLogService
        .logPermissionChange(action, userId!, organizationId!)
        .catch(() => {});

      sendSuccess(res, null, "Approval workflows updated");
    },
  );
}