import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { ConsultationSettingsService } from "./consultation-settings.service";

export class ConsultationSettingsController {
  private service: ConsultationSettingsService;

  constructor(service: ConsultationSettingsService) {
    this.service = service;
  }

  getSettings = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.service.getSettings(organizationId!);
    sendSuccess(res, result, "Consultation settings retrieved successfully");
  });

  upsertSettings = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.service.upsertSettings(
      organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Consultation settings saved successfully");
  });

  listLocations = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const includeInactive = req.query.includeInactive === "true";
    const result = await this.service.listLocations(
      organizationId!,
      includeInactive,
    );
    sendSuccess(res, result, "Locations retrieved successfully");
  });

  createLocation = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.service.createLocation(
      organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Location created successfully", 201);
  });

  updateLocation = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.service.updateLocation(
      organizationId!,
      req.params.locationId as string,
      req.body,
    );
    sendSuccess(res, result, "Location updated successfully");
  });

  deleteLocation = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    await this.service.deleteLocation(
      organizationId!,
      req.params.locationId as string,
    );
    sendSuccess(res, null, "Consultation location deleted successfully");
  });
}
