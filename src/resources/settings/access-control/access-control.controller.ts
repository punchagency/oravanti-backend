import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { AccessControlService } from "./access-control.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError } from "../../../utils/error/app-error";

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
    
      const result = await this.accessControlService.getRoleOverview(
        req.firmId!,
      );
      res.status(200).json(result);
    
  });

  getPermissions = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.accessControlService.getPermissions(
        req.firmId!,
      );
      res.status(200).json(result);
    
  });

  savePermissions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { permissions } = req.body;

    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new BadRequestError("permissions array is required");
    }

    
      await this.accessControlService.savePermissions(req.firmId!, permissions);

      const action =
        permissions.length === 1
          ? `Updated ${permissions[0].module} permissions for ${permissions[0].role} role`
          : "Updated module permissions";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.firmId!)
        .catch(() => {});

      res.status(200).json({ message: "Permissions saved" });
    
  });
}
