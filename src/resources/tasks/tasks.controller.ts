import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as tasksService from "./tasks.service";

export const getTaskStats = async (req: AuthRequest, res: Response) => {
  try {
    const stats = await tasksService.getTaskStats(req.firmId!);
    res.status(200).json(stats);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getAllTasks = async (req: AuthRequest, res: Response) => {
  const { search, status, priority, assignedToId } = req.query;
  try {
    const result = await tasksService.getAllTasks(req.firmId!, {
      search: search as string,
      status: status as string,
      priority: priority as string,
      assignedToId: assignedToId as string,
    });
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getTaskById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await tasksService.getTaskById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const createTask = async (req: AuthRequest, res: Response) => {
  const { title, description, caseId, assignedToId, dueDate } = req.body;

  if (!title || !description || !caseId || !assignedToId || !dueDate) {
    throw new BadRequestError(
      "title, description, caseId, assignedToId and dueDate are required",
    );
  }

  try {
    const result = await tasksService.createTask({
      ...req.body,
      firmId: req.firmId!,
      assignedById: req.adminId!,
    });
    res.status(201).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const result = await tasksService.updateTask(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
  try {
    await tasksService.deleteTask(req.params.id as string, req.firmId!);
    res.status(200).json({ message: "Task deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
