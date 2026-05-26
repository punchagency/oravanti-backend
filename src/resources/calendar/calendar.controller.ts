import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as calendarService from "./calendar.service";

export const getCalendarEvents = async (req: AuthRequest, res: Response) => {
  const { year, month, teamId, eventTypes } = req.query;

  const filters = {
    year: year ? parseInt(year as string, 10) : undefined,
    month: month ? parseInt(month as string, 10) : undefined,
    teamId: teamId ? (teamId as string) : undefined,
    eventTypes: eventTypes ? (eventTypes as string).split(",") : undefined,
  };

  try {
    const result = await calendarService.getCalendarEvents(
      req.firmId!,
      filters,
    );
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getCalendarEventById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await calendarService.getCalendarEventById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const createCalendarEvent = async (req: AuthRequest, res: Response) => {
  try {
    const result = await calendarService.createCalendarEvent(
      req.firmId!,
      req.body,
    );
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const updateCalendarEvent = async (req: AuthRequest, res: Response) => {
  try {
    const result = await calendarService.updateCalendarEvent(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Event not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const deleteCalendarEvent = async (req: AuthRequest, res: Response) => {
  try {
    await calendarService.deleteCalendarEvent(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Event deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getCalendarStrip = async (req: AuthRequest, res: Response) => {
  const teamId = req.query.teamId as string | undefined;
  try {
    const result = await calendarService.getCalendarStrip(req.firmId!, teamId);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const createServiceRequestEvent = async (
  req: AuthRequest,
  res: Response,
) => {
  const { clientId, caseId, clientName, formType, assignedStaffId, teamId } =
    req.body;

  if (!clientId || !caseId || !clientName || !formType) {
    throw new BadRequestError(
      "clientId, caseId, clientName, and formType are required",
    );
  }

  try {
    const result = await calendarService.createServiceRequestEvent(
      req.firmId!,
      clientId,
      caseId,
      clientName,
      formType,
      assignedStaffId,
      teamId,
    );
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const resolveServiceRequestEvents = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    await calendarService.resolveServiceRequestEvents(
      req.params.caseId as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Service request events resolved" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const scheduleNextServiceRequest = async (
  req: AuthRequest,
  res: Response,
) => {
  const { clientId, caseId, clientName, formType, assignedStaffId, teamId } =
    req.body;

  if (!clientId || !caseId || !clientName || !formType) {
    throw new BadRequestError(
      "clientId, caseId, clientName, and formType are required",
    );
  }

  try {
    const result = await calendarService.scheduleNextServiceRequest(
      req.firmId!,
      clientId,
      caseId,
      clientName,
      formType,
      assignedStaffId,
      teamId,
    );
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};
