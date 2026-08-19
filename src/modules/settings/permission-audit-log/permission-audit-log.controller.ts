import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { PermissionAuditLogService } from "./permission-audit-log.service";

export class PermissionAuditLogController {
  private auditLogService: PermissionAuditLogService;

  constructor(auditLogService: PermissionAuditLogService) {
    this.auditLogService = auditLogService;
  }

  getPermissionAuditLog = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    const result = await this.auditLogService.getPermissionAuditLog(
      organizationId!,
      limit,
    );
    sendSuccess(res, result, "Permission audit log retrieved successfully");
  });
}
