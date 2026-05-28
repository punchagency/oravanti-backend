import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { CalendarService } from "./calendar.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

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
      req.firmId!,
      filters,
    );
    res.status(200).json(result);
  });

  getCalendarEventById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.getCalendarEventById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    res.status(200).json(result);
  });

  createCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.createCalendarEvent(
      req.firmId!,
      req.body,
    );
    res.status(201).json(result);
  });

  updateCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.calendarService.updateCalendarEvent(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    res.status(200).json(result);
  });

  deleteCalendarEvent = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.calendarService.deleteCalendarEvent(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Event deleted" });
  });

  getCalendarStrip = asyncWrap(async (req: AuthRequest, res: Response) => {
    const teamId = req.query.teamId as string | undefined;
    const result = await this.calendarService.getCalendarStrip(
      req.firmId!,
      teamId,
    );
    res.status(200).json(result);
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

      if (!clientId || !caseId || !clientName || !formType) {
        throw new BadRequestError(
          "clientId, caseId, clientName, and formType are required",
        );
      }

      const result = await this.calendarService.createServiceRequestEvent(
        req.firmId!,
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      );
      res.status(201).json(result);
    },
  );

  resolveServiceRequestEvents = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      await this.calendarService.resolveServiceRequestEvents(
        req.params.caseId as string,
        req.firmId!,
      );
      res.status(200).json({ message: "Service request events resolved" });
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

      if (!clientId || !caseId || !clientName || !formType) {
        throw new BadRequestError(
          "clientId, caseId, clientName, and formType are required",
        );
      }

      const result = await this.calendarService.scheduleNextServiceRequest(
        req.firmId!,
        clientId,
        caseId,
        clientName,
        formType,
        assignedStaffId,
        teamId,
      );
      res.status(201).json(result);
    },
  );
}
