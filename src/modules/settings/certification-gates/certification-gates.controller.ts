import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
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

  getCertificationGates = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.certifcationGatesService.getCertificationGates(
      organizationId!,
    );
    sendSuccess(res, result, "Certification gates retrieved successfully");
  });

  updateCertificationGates = asyncWrap(
    async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
      const { gates } = req.body;

      await this.certifcationGatesService.updateCertificationGates(
        organizationId!,
        gates,
      );
      await this.permissionAuditLogService.logPermissionChange(
        "Modified paralegal certification requirements",
        userId!,
        organizationId!,
      );
      sendSuccess(res, null, "Certification gates updated");
    },
  );

  getActivationRequirements = asyncWrap(
    async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
      const result =
        await this.certifcationGatesService.getActivationRequirements(
          organizationId!,
        );
      sendSuccess(res, result, "Activation requirements retrieved successfully");
    },
  );

  updateActivationRequirements = asyncWrap(
    async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
      const { certificationCodes } = req.body;

      const result =
        await this.certifcationGatesService.updateActivationRequirements(
          organizationId!,
          certificationCodes,
        );
      await this.permissionAuditLogService.logPermissionChange(
        "Updated paralegal activation requirements",
        staffId!,
        organizationId!,
      );
      sendSuccess(res, result, `Activation requirements updated. ${result.updated} paralegal(s) re-evaluated.`);
    },
  );
}