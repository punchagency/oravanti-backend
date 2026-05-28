import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { PermissionAuditLogController } from "./permission-audit-log.controller";

export class PermissionAuditLogRouter {
  public router: Router;
  public path: string;
  private auditLogController: PermissionAuditLogController;

  constructor(auditLogController: PermissionAuditLogController) {
    this.router = Router();
    this.path = "/settings/permission-audit-log";
    this.auditLogController = auditLogController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.auditLogController.getPermissionAuditLog);
  }
}
