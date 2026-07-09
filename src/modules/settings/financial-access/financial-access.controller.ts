import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
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

  getFinancialAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.financialAccessService.getFinancialAccess(
      req.organizationId!,
    );
    sendSuccess(res, result, "Financial access retrieved successfully");
  });

  updateFinancialAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { controls } = req.body;

    await this.financialAccessService.updateFinancialAccess(
      req.organizationId!,
      controls,
    );

    const action =
      controls.length === 1
        ? `Updated financial access for ${controls[0].role} role`
        : "Updated financial access controls";
    this.auditLogService
      .logPermissionChange(action, req.userId!, req.organizationId!)
      .catch(() => {});

    sendSuccess(res, null, "Financial access controls updated");
  });
}
