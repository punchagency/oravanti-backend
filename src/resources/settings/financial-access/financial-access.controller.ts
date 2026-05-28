import { Response } from "express";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { FinancialAccessService } from "./financial-access.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError } from "../../../utils/error/app-error";

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
        req.firmId!,
      );
      res.status(200).json(result);
    
  });

  updateFinancialAccess = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { controls } = req.body;

    if (!Array.isArray(controls) || controls.length === 0) {
      throw new BadRequestError("controls array is required");
    }

    
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
    
  });
}
