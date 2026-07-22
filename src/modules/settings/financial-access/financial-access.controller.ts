import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
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

  getFinancialAccess = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    const result = await this.financialAccessService.getFinancialAccess(
      organizationId!,
    );
    sendSuccess(res, result, "Financial access retrieved successfully");
  });

  updateFinancialAccess = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    const { controls } = req.body;

    await this.financialAccessService.updateFinancialAccess(
      organizationId!,
      controls,
    );

    const action =
      controls.length === 1
        ? `Updated financial access for ${controls[0].role} role`
        : "Updated financial access controls";
    this.auditLogService
      .logPermissionChange(action, userId!, organizationId!)
      .catch(() => {});

    sendSuccess(res, null, "Financial access controls updated");
  });
}