import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { CalendarService } from "./calendar.service";

export class CalendarController {
  private calendarService: CalendarService;

  constructor(calendarService: CalendarService) {
    this.calendarService = calendarService;
  }

  getCalendarEvents = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const { year, month, teamId, eventTypes } = req.query;

    const filters = {
      year: year ? parseInt(year as string, 10) : undefined,
      month: month ? parseInt(month as string, 10) : undefined,
      teamId: teamId ? (teamId as string) : undefined,
      eventTypes: eventTypes ? (eventTypes as string).split(",") : undefined,
    };

    const result = await this.calendarService.getCalendarEvents(
      organizationId!,
      filters,
    );
    sendSuccess(res, result, "Calendar events retrieved successfully");
  });

  getCalendarEventById = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.calendarService.getCalendarEventById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    sendSuccess(res, result, "Calendar event retrieved successfully");
  });

  createCalendarEvent = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const body = {
      ...req.body,
      startTime: new Date(req.body.startTime),
      endTime: req.body.endTime ? new Date(req.body.endTime) : undefined,
    };
    const result = await this.calendarService.createCalendarEvent(
      organizationId!,
      body,
    );
    sendSuccess(res, result, "Calendar event created successfully", 201);
  });

  updateCalendarEvent = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const body = { ...req.body };
    if (body.startTime) body.startTime = new Date(body.startTime);
    if (body.endTime) body.endTime = new Date(body.endTime);
    const result = await this.calendarService.updateCalendarEvent(
      req.params.id as string,
      organizationId!,
      body,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    sendSuccess(res, result, "Calendar event updated successfully");
  });

  deleteCalendarEvent = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    await this.calendarService.deleteCalendarEvent(
      req.params.id as string,
      organizationId!,
    );
    sendSuccess(res, null, "Calendar event deleted successfully");
  });

  getCalendarStrip = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const teamId = req.query.teamId as string | undefined;
    const result = await this.calendarService.getCalendarStrip(
      organizationId!,
      teamId,
    );
    sendSuccess(res, result, "Calendar strip retrieved successfully");
  });

  createServiceRequestEvent = asyncWrap(
    async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
      const {
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      } = req.body;

      const result = await this.calendarService.createServiceRequestEvent(
        organizationId!,
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      );
      sendSuccess(res, result, "Service request event created successfully", 201);
    },
  );

  resolveServiceRequestEvents = asyncWrap(
    async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
      await this.calendarService.resolveServiceRequestEvents(
        req.params.caseId as string,
        organizationId!,
      );
      sendSuccess(res, null, "Service request events resolved successfully");
    },
  );

  scheduleNextServiceRequest = asyncWrap(
    async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
      const {
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      } = req.body;

      const result = await this.calendarService.scheduleNextServiceRequest(
        organizationId!,
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      );
      sendSuccess(res, result, "Service request scheduled successfully", 201);
    },
  );
}
