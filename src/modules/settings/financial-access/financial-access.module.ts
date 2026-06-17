import { CommonValidation } from "../../../validation/common.validation";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { FinancialAccessController } from "./financial-access.controller";
import { FinancialAccessRouter } from "./financial-access.routes";
import { FinancialAccessService } from "./financial-access.service";

export class FinancialAccessModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const permissionAuditLogService = new PermissionAuditLogService();
    const service = new FinancialAccessService();
    const controller = new FinancialAccessController(
      service,
      permissionAuditLogService,
    );
    const router = new FinancialAccessRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
