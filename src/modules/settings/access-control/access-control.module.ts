import { CommonValidation } from "../../../validation/common.validation";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { AccessControlController } from "./access-control.controller";
import { AccessControlRouter } from "./access-control.routes";
import { AccessControlService } from "./access-control.service";
import { CertificationGatesController } from "../certification-gates/certification-gates.controller";
import { CertificationGatesService } from "../certification-gates/certification-gates.service";

export class AccessControlModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const permissionAuditLogService = new PermissionAuditLogService();
    const accessControlService = new AccessControlService();
    const certificationGatesService = new CertificationGatesService();
    const accessControlController = new AccessControlController(
      accessControlService,
      permissionAuditLogService,
    );
    const certificationGatesController = new CertificationGatesController(
      certificationGatesService,
      permissionAuditLogService,
    );
    const router = new AccessControlRouter(
      accessControlController,
      certificationGatesController,
      commonValidation,
    );
    this.router = router.router;
    this.path = router.path;
  }
}
