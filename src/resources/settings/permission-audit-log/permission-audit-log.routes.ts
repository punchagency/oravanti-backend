import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { PermissionAuditLogController } from "./permission-audit-log.controller";

export class PermissionAuditLogRouter {
  public router: Router;
  public path: string;
  private auditLogController: PermissionAuditLogController;
  private validation: CommonValidation;

  constructor(
    auditLogController: PermissionAuditLogController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/permission-audit-log";
    this.auditLogController = auditLogController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/",
      validateRequest({
        query: this.validation.query({
          limit: this.validation.nonEmptyString.optional(),
        }),
      }),
      this.auditLogController.getPermissionAuditLog,
    );
  }
}
