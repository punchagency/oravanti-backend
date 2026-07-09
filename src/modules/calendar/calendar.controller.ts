import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { CalendarService } from "./calendar.service";

export class CalendarController {
  private calendarService: CalendarService;

  constructor(calendarService: CalendarService) {
    this.calendarService = calendarService;
  }

  getCalendarEvents = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { year, month, teamId, eventTypes } = req.query;

    const filters = {
      year: year ? parseInt(year as string, 10) : undefined,
      month: month ? parseInt(month as string, 10) : undefined,
      teamId: teamId ? (teamId as string) : undefined,
      eventTypes: eventTypes ? (eventTypes as string).split(",") : undefined,
    };

    const result = await this.calendarService.getCalendarEvents(
      req.organizationId!,
      filters,
    );
    sendSuccess(res, result, "Calendar events retrieved successfully");
  });

  getCalendarEventById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.getCalendarEventById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    sendSuccess(res, result, "Calendar event retrieved successfully");
  });

  createCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.createCalendarEvent(
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, result, "Calendar event created successfully", 201);
  });

  updateCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.updateCalendarEvent(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    sendSuccess(res, result, "Calendar event updated successfully");
  });

  deleteCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.calendarService.deleteCalendarEvent(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, null, "Calendar event deleted successfully");
  });

  getCalendarStrip = asyncWrap(async (req: AuthRequest, res: Response) => {
    const teamId = req.query.teamId as string | undefined;
    const result = await this.calendarService.getCalendarStrip(
      req.organizationId!,
      teamId,
    );
    sendSuccess(res, result, "Calendar strip retrieved successfully");
  });

  createServiceRequestEvent = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const {
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      } = req.body;

      const result = await this.calendarService.createServiceRequestEvent(
        req.organizationId!,
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
    async (req: AuthRequest, res: Response) => {
      await this.calendarService.resolveServiceRequestEvents(
        req.params.caseId as string,
        req.organizationId!,
      );
      sendSuccess(res, null, "Service request events resolved successfully");
    },
  );

  scheduleNextServiceRequest = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const {
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      } = req.body;

      const result = await this.calendarService.scheduleNextServiceRequest(
        req.organizationId!,
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
