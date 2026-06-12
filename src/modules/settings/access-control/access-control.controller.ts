import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
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

  getRoleOverview = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.accessControlService.getRoleOverview(req.organizationId!);
    res.status(200).json(result);
  });

  getPermissions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.accessControlService.getPermissions(req.organizationId!);
    res.status(200).json(result);
  });

  savePermissions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { permissions } = req.body;

    await this.accessControlService.savePermissions(req.organizationId!, permissions);

    const action =
      permissions.length === 1
        ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
        : "Updated module permissions";
    this.auditLogService
      .logPermissionChange(action, req.userId!, req.organizationId!)
      .catch(() => {});

    res.status(200).json({ message: "Permissions saved" });
  });
}
