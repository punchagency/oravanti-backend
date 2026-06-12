import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { PermissionAuditLogService } from "../permission-audit-log/permission-audit-log.service";
import { DataAccessService } from "./data-access.service";

export class DataAccessController {
  private dataAccessService: DataAccessService;
  private auditLogService: PermissionAuditLogService;

  constructor(
    dataAccessService: DataAccessService,
    auditLogService: PermissionAuditLogService,
  ) {
    this.dataAccessService = dataAccessService;
    this.auditLogService = auditLogService;
  }

  getDataAccessControls = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.dataAccessService.getDataAccessControls(
      req.organizationId!,
    );
    res.status(200).json(result);
  });

  updateDataAccessControls = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { controls } = req.body;

      await this.dataAccessService.updateDataAccessControls(
        req.organizationId!,
        controls,
      );

      const action =
        controls.length === 1
          ? `Updated ${controls[0].dataType.replace(/_/g, " ")} access for ${controls[0].role} role`
          : "Updated data access controls";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.organizationId!)
        .catch(() => {});

      res.status(200).json({ message: "Data access controls updated" });
    },
  );
}
