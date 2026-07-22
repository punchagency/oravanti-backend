import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { StaffAvailabilityService } from "./staff-availability.service";

export class StaffAvailabilityController {
  private service: StaffAvailabilityService;

  constructor(service: StaffAvailabilityService) {
    this.service = service;
  }

  getAvailability = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.getAvailability(
      organizationId!,
      req.params.staffId as string,
    );
    sendSuccess(res, result, "Availability retrieved successfully");
  });

  setWeeklyAvailability = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.setWeeklyAvailability(
      organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Weekly availability saved successfully");
  });

  setBreaks = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.setBreaks(
      organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Breaks saved successfully");
  });

  createOverride = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.createOverride(
      organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Override created successfully", 201);
  });

  updateOverride = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.updateOverride(
      organizationId!,
      req.params.staffId as string,
      req.params.overrideId as string,
      req.body,
    );
    sendSuccess(res, result, "Override updated successfully");
  });

  deleteOverride = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    await this.service.deleteOverride(
      organizationId!,
      req.params.staffId as string,
      req.params.overrideId as string,
    );
    sendSuccess(res, null, "Availability override deleted successfully");
  });

  createTimeOff = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.createTimeOff(
      organizationId!,
      req.params.staffId as string,
      req.body,
    );
    sendSuccess(res, result, "Time off created successfully", 201);
  });

  updateTimeOff = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.updateTimeOff(
      organizationId!,
      req.params.staffId as string,
      req.params.timeOffId as string,
      req.body,
    );
    sendSuccess(res, result, "Time off updated successfully");
  });

  deleteTimeOff = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    await this.service.deleteTimeOff(
      organizationId!,
      req.params.staffId as string,
      req.params.timeOffId as string,
    );
    sendSuccess(res, null, "Time-off entry deleted successfully");
  });
}
