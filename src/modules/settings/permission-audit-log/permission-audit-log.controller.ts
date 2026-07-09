import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { PermissionAuditLogService } from "./permission-audit-log.service";

export class PermissionAuditLogController {
  private auditLogService: PermissionAuditLogService;

  constructor(auditLogService: PermissionAuditLogService) {
    this.auditLogService = auditLogService;
  }

  getPermissionAuditLog = asyncWrap(async (req: AuthRequest, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    const result = await this.auditLogService.getPermissionAuditLog(
      req.organizationId!,
      limit,
    );
    sendSuccess(res, result, "Permission audit log retrieved successfully");
  });
}
