import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { ConsultationSettingsService } from "./consultation-settings.service";

export class ConsultationSettingsController {
  private service: ConsultationSettingsService;

  constructor(service: ConsultationSettingsService) {
    this.service = service;
  }

  getSettings = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.getSettings(req.organizationId!);
    sendSuccess(res, result, "Consultation settings retrieved successfully");
  });

  upsertSettings = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.upsertSettings(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Consultation settings saved successfully");
  });

  listLocations = asyncWrap(async (req: AuthRequest, res: Response) => {
    const includeInactive = req.query.includeInactive === "true";
    const result = await this.service.listLocations(
      req.organizationId!,
      includeInactive,
    );
    sendSuccess(res, result, "Locations retrieved successfully");
  });

  createLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.createLocation(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Location created successfully", 201);
  });

  updateLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.updateLocation(
      req.organizationId!,
      req.params.locationId as string,
      req.body,
    );
    sendSuccess(res, result, "Location updated successfully");
  });

  deleteLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.service.deleteLocation(
      req.organizationId!,
      req.params.locationId as string,
    );
    sendSuccess(res, null, "Consultation location deleted successfully");
  });
}
