import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "./permission-audit-log.service";

export class PermissionAuditLogController {
  private auditLogService: PermissionAuditLogService;

  constructor(auditLogService: PermissionAuditLogService) {
    this.auditLogService = auditLogService;
  }

  getPermissionAuditLog = async (req: AuthRequest, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    try {
      const result = await this.auditLogService.getPermissionAuditLog(
        req.firmId!,
        limit,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
