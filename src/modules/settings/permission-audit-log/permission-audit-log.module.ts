import { CommonValidation } from "../../../validation/common.validation";
import { PermissionAuditLogController } from "./permission-audit-log.controller";
import { PermissionAuditLogRouter } from "./permission-audit-log.routes";
import { PermissionAuditLogService } from "./permission-audit-log.service";

export class PermissionAuditLogModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new PermissionAuditLogService();
    const controller = new PermissionAuditLogController(service);
    const router = new PermissionAuditLogRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
