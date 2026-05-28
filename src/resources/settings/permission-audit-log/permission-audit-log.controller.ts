import { Response } from "express";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "./permission-audit-log.service";

import asyncWrap from "../../../utils/asyncWrapper";

export class PermissionAuditLogController {
  private auditLogService: PermissionAuditLogService;

  constructor(auditLogService: PermissionAuditLogService) {
    this.auditLogService = auditLogService;
  }

  getPermissionAuditLog = asyncWrap(async (req: AuthRequest, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    
      const result = await this.auditLogService.getPermissionAuditLog(
        req.firmId!,
        limit,
      );
      res.status(200).json(result);
    
  });
}
