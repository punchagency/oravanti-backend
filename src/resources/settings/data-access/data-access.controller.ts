import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
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

  getDataAccessControls = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.dataAccessService.getDataAccessControls(
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateDataAccessControls = async (req: AuthRequest, res: Response) => {
    const { controls } = req.body;

    if (!Array.isArray(controls) || controls.length === 0) {
      res.status(400).json({ message: "controls array is required" });
      return;
    }

    try {
      await this.dataAccessService.updateDataAccessControls(
        req.firmId!,
        controls,
      );

      const action =
        controls.length === 1
          ? `Updated ${controls[0].dataType.replace(/_/g, " ")} access for ${controls[0].role} role`
          : "Updated data access controls";
      this.auditLogService
        .logPermissionChange(action, req.userId!, req.firmId!)
        .catch(() => {});

      res.status(200).json({ message: "Data access controls updated" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
