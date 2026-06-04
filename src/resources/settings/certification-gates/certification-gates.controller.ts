import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { CertificationGatesService } from "./certification-gates.service";

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
      req.organizationId!,
    );
    res.status(200).json(result);
  });

  updateCertificationGates = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { gates } = req.body;

      await this.certifcationGatesService.updateCertificationGates(
        req.organizationId!,
        gates,
      );
      await this.permissionAuditLogService.logPermissionChange(
        "Modified paralegal certification requirements",
        req.userId!,
        req.organizationId!,
      );
      res.status(200).json({ message: "Certification gates updated" });
    },
  );

  getActivationRequirements = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const result =
        await this.certifcationGatesService.getActivationRequirements(
          req.organizationId!,
        );
      res.status(200).json(result);
    },
  );

  updateActivationRequirements = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { certificationCodes } = req.body;

      const result =
        await this.certifcationGatesService.updateActivationRequirements(
          req.organizationId!,
          certificationCodes,
        );
      await this.permissionAuditLogService.logPermissionChange(
        "Updated paralegal activation requirements",
        req.userId!,
        req.organizationId!,
      );
      res.status(200).json({
        message: `Activation requirements updated. ${result.updated} paralegal(s) re-evaluated.`,
      });
    },
  );
}
