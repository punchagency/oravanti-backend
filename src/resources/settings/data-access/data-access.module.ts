import { CommonValidation } from "../../../validation/common.validation";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { DataAccessController } from "./data-access.controller";
import { DataAccessRouter } from "./data-access.routes";
import { DataAccessService } from "./data-access.service";

export class DataAccessModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const permissionAuditLogService = new PermissionAuditLogService();
    const service = new DataAccessService();
    const controller = new DataAccessController(
      service,
      permissionAuditLogService,
    );
    const router = new DataAccessRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
