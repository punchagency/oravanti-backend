import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
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
    sendSuccess(res, result, "Availability retrieved successfully");
  });

  setWeeklyAvailability = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.setWeeklyAvailability(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Weekly availability saved successfully");
  });

  setBreaks = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.setBreaks(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Breaks saved successfully");
  });

  createOverride = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.createOverride(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Override created successfully", 201);
  });

  updateOverride = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.updateOverride(
      req.organizationId!,
      req.params.staffId as string,
      req.params.overrideId as string,
      req.body,
    );
    sendSuccess(res, result, "Override updated successfully");
  });

  deleteOverride = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.service.deleteOverride(
      req.organizationId!,
      req.params.staffId as string,
      req.params.overrideId as string,
    );
    sendSuccess(res, null, "Availability override deleted successfully");
  });

  createTimeOff = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.createTimeOff(
      req.organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Time off created successfully", 201);
  });

  updateTimeOff = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.service.updateTimeOff(
      req.organizationId!,
      req.params.staffId as string,
      req.params.timeOffId as string,
      req.body,
    );
    sendSuccess(res, result, "Time off updated successfully");
  });

  deleteTimeOff = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.service.deleteTimeOff(
      req.organizationId!,
      req.params.staffId as string,
      req.params.timeOffId as string,
    );
    sendSuccess(res, null, "Time-off entry deleted successfully");
  });
}
