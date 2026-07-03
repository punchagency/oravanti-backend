import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { ConsultationSettingsService } from "./consultation-settings.service";

export class ConsultationSettingsController {
  private service: ConsultationSettingsService;

  constructor(service: ConsultationSettingsService) {
    this.service = service;
  }

  getSettings = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.getSettings(req.organizationId!);
    res.status(200).json(result);
  });

  upsertSettings = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.upsertSettings(
      req.organizationId!,
      req.body,
    );
    res
      .status(200)
      .json({ message: "Consultation settings saved", settings: result });
  });

  listLocations = asyncWrap(async (req: AuthRequest, res: Response) => {
    const includeInactive = req.query.includeInactive === "true";
    const result = await this.service.listLocations(
      req.organizationId!,
      includeInactive,
    );
    res.status(200).json(result);
  });

  createLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.createLocation(
      req.organizationId!,
      req.body,
    );
    res.status(201).json(result);
  });

  updateLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.updateLocation(
      req.organizationId!,
      req.params.locationId as string,
      req.body,
    );
    res.status(200).json(result);
  });

  deleteLocation = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.service.deleteLocation(
      req.organizationId!,
      req.params.locationId as string,
    );
    res.status(200).json({ message: "Consultation location deleted" });
  });
}
