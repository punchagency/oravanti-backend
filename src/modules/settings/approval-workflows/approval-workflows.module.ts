import { CommonValidation } from "../../../validation/common.validation";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { ApprovalWorkflowsController } from "./approval-workflows.controller";
import { ApprovalWorkflowsRouter } from "./approval-workflows.routes";
import { ApprovalWorkflowsService } from "./approval-workflows.service";

export class ApprovalWorkflowsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const permissionAuditLogService = new PermissionAuditLogService();
    const service = new ApprovalWorkflowsService();
    const controller = new ApprovalWorkflowsController(
      service,
      permissionAuditLogService,
    );
    const router = new ApprovalWorkflowsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
