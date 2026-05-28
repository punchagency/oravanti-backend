import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { CertificationGatesService } from "./certification-gates.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError } from "../../../utils/error/app-error";

export class CertificationGatesController {
  private certifcationGatesService: CertificationGatesService;
  private permissionAuditLogService: PermissionAuditLogService;

  constructor(
    gatesService: CertificationGatesService,
    auditLogService: PermissionAuditLogService,
  ) {
    this.certifcationGatesService = gatesService;
    this.permissionAuditLogService = auditLogService;
  }

  getCertificationGates = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.certifcationGatesService.getCertificationGates(
        req.firmId!,
      );
      res.status(200).json(result);
    
  });

  updateCertificationGates = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { gates } = req.body;

    if (!Array.isArray(gates) || gates.length === 0) {
      throw new BadRequestError("gates array is required");
    }

    
      await this.certifcationGatesService.updateCertificationGates(
        req.firmId!,
        gates,
      );
      await this.permissionAuditLogService.logPermissionChange(
        "Modified paralegal certification requirements",
        req.userId!,
        req.firmId!,
      );
      res.status(200).json({ message: "Certification gates updated" });
    
  });

  getActivationRequirements = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result =
        await this.certifcationGatesService.getActivationRequirements(
          req.firmId!,
        );
      res.status(200).json(result);
    
  });

  updateActivationRequirements = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { certificationCodes } = req.body;

    if (!Array.isArray(certificationCodes)) {
      throw new BadRequestError("certificationCodes array is required");
    }

    
      const result =
        await this.certifcationGatesService.updateActivationRequirements(
          req.firmId!,
          certificationCodes,
        );
      await this.permissionAuditLogService.logPermissionChange(
        "Updated paralegal activation requirements",
        req.userId!,
        req.firmId!,
      );
      res.status(200).json({
        message: `Activation requirements updated. ${result.updated} paralegal(s) re-evaluated.`,
      });
    
  });
}
