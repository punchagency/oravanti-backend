import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { AccessControlService } from "./access-control.service";

export class AccessControlController {
  private accessControlService: AccessControlService;
  private auditLogService: PermissionAuditLogService;

  constructor(
    accessControlService: AccessControlService,
    auditLogService: PermissionAuditLogService,
  ) {
    this.accessControlService = accessControlService;
    this.auditLogService = auditLogService;
  }

  getRoleOverview = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.accessControlService.getRoleOverview(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getPermissions = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.accessControlService.getPermissions(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  savePermissions = async (req: AuthRequest, res: Response) => {
    const { permissions } = req.body;

    if (!Array.isArray(permissions) || permissions.length === 0) {
      res.status(400).json({ message: "permissions array is required" });
      return;
    }

    try {
      await this.accessControlService.savePermissions(req.firmId!, permissions);

      const action =
        permissions.length === 1
          ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
          : "Updated module permissions";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.firmId!)
        .catch(() => {});

      res.status(200).json({ message: "Permissions saved" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
