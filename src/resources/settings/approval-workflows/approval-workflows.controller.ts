import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
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

  getApprovalWorkflows = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.approvalWorkflowsService.getApprovalWorkflows(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateApprovalWorkflows = async (req: AuthRequest, res: Response) => {
    const { workflows } = req.body;

    if (!Array.isArray(workflows) || workflows.length === 0) {
      res.status(400).json({ message: "workflows array is required" });
      return;
    }

    try {
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
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
