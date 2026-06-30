import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { StaffAvailabilityService } from "./staff-availability.service";

export class StaffAvailabilityController {
  private service: StaffAvailabilityService;

  constructor(service: StaffAvailabilityService) {
    this.service = service;
  }

  getAvailability = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.getAvailability(
      req.organizationId!,
      req.params.staffId as string,
    );
    res.status(200).json(result);
  });

  setWeeklyAvailability = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.setWeeklyAvailability(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    res.status(200).json(result);
  });

  setBreaks = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.setBreaks(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    res.status(200).json(result);
  });

  createOverride = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.createOverride(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    res.status(201).json(result);
  });

  deleteOverride = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.service.deleteOverride(
      req.organizationId!,
      req.params.staffId as string,
      req.params.overrideId as string,
    );
    res.status(200).json({ message: "Availability override deleted" });
  });
}
