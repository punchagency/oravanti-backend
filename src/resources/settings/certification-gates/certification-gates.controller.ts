import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
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

  getCertificationGates = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.certifcationGatesService.getCertificationGates(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateCertificationGates = async (req: AuthRequest, res: Response) => {
    const { gates } = req.body;

    if (!Array.isArray(gates) || gates.length === 0) {
      res.status(400).json({ message: "gates array is required" });
      return;
    }

    try {
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
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getActivationRequirements = async (req: AuthRequest, res: Response) => {
    try {
      const result =
        await this.certifcationGatesService.getActivationRequirements(
          req.firmId!,
        );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateActivationRequirements = async (req: AuthRequest, res: Response) => {
    const { certificationCodes } = req.body;

    if (!Array.isArray(certificationCodes)) {
      res.status(400).json({ message: "certificationCodes array is required" });
      return;
    }

    try {
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
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
