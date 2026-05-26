import { Response } from "express";
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
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getCalendarEventById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await calendarService.getCalendarEventById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      res.status(404).json({ message: "Event not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
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
    res.status(400).json({ message: (error as Error).message });
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
      res.status(404).json({ message: "Event not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
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
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getCalendarStrip = async (req: AuthRequest, res: Response) => {
  const teamId = req.query.teamId as string | undefined;
  try {
    const result = await calendarService.getCalendarStrip(req.firmId!, teamId);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const createServiceRequestEvent = async (
  req: AuthRequest,
  res: Response,
) => {
  const { clientId, caseId, clientName, formType, assignedStaffId, teamId } =
    req.body;

  if (!clientId || !caseId || !clientName || !formType) {
    res
      .status(400)
      .json({
        message: "clientId, caseId, clientName, and formType are required",
      });
    return;
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
    res.status(400).json({ message: (error as Error).message });
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
    res.status(500).json({ message: (error as Error).message });
  }
};

export const scheduleNextServiceRequest = async (
  req: AuthRequest,
  res: Response,
) => {
  const { clientId, caseId, clientName, formType, assignedStaffId, teamId } =
    req.body;

  if (!clientId || !caseId || !clientName || !formType) {
    res
      .status(400)
      .json({
        message: "clientId, caseId, clientName, and formType are required",
      });
    return;
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
    res.status(400).json({ message: (error as Error).message });
  }
};
