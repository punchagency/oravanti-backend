import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
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

  getDataAccessControls = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.dataAccessService.getDataAccessControls(
      organizationId!,
    );
    sendSuccess(res, result, "Data access controls retrieved successfully");
  });

  updateDataAccessControls = asyncWrap(
    async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
      const { controls } = req.body;

      await this.dataAccessService.updateDataAccessControls(
        organizationId!,
        controls,
      );

      const action =
        controls.length === 1
          ? `Updated ${controls[0].dataType.replace(/_/g, " ")} access for ${controls[0].role} role`
          : "Updated data access controls";
      this.auditLogService
        .logPermissionChange(action, userId!, organizationId!)
        .catch(() => {});

      sendSuccess(res, null, "Data access controls updated");
    },
  );
}