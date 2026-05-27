import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { FinancialAccessService } from "./financial-access.service";

export class FinancialAccessController {
  private financialAccessService: FinancialAccessService;
  private auditLogService: PermissionAuditLogService;

  constructor(
    financialAccessService: FinancialAccessService,
    auditLogService: PermissionAuditLogService,
  ) {
    this.financialAccessService = financialAccessService;
    this.auditLogService = auditLogService;
  }

  getFinancialAccess = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.financialAccessService.getFinancialAccess(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateFinancialAccess = async (req: AuthRequest, res: Response) => {
    const { controls } = req.body;

    if (!Array.isArray(controls) || controls.length === 0) {
      res.status(400).json({ message: "controls array is required" });
      return;
    }

    try {
      await this.financialAccessService.updateFinancialAccess(
        req.firmId!,
        controls,
      );

      const action =
        controls.length === 1
          ? `Updated financial access for ${controls[0].role} role`
          : "Updated financial access controls";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.firmId!)
        .catch(() => {});

      res.status(200).json({ message: "Financial access controls updated" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
