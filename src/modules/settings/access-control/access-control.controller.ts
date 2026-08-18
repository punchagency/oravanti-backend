import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
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

  getRoleOverview = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.accessControlService.getRoleOverview(organizationId!);
    sendSuccess(res, result, "Role overview retrieved successfully");
  });

  getPermissions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.accessControlService.getPermissions(organizationId!);
    sendSuccess(res, result, "Permissions retrieved successfully");
  });

  savePermissions = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    const { permissions } = req.body;

    await this.accessControlService.savePermissions(organizationId!, permissions);

    const action =
      permissions.length === 1
        ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
        : "Updated module permissions";
    this.auditLogService
      .logPermissionChange(action, userId!, organizationId!)
      .catch(() => {});

    sendSuccess(res, null, "Permissions saved successfully");
  });
}