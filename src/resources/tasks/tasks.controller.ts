import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import * as tasksService from "./tasks.service";

export class TasksController {
  private tasksService: tasksService.TasksService;

  constructor(tasksService: tasksService.TasksService) {
    this.tasksService = tasksService;
  }

  getTaskStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const stats = await this.tasksService.getTaskStats(req.firmId!);
    res.status(200).json(stats);
  });

  getAllTasks = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, status, priority, assignedToId } = req.query;

    const result = await this.tasksService.getAllTasks(req.firmId!, {
      search: search as string,
      status: status as string,
      priority: priority as string,
      assignedToId: assignedToId as string,
    });
    res.status(200).json(result);
  });

  getTaskById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.tasksService.getTaskById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    res.status(200).json(result);
  });

  createTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, caseId, assignedToId, dueDate } = req.body;

    if (!title || !description || !caseId || !assignedToId || !dueDate) {
      throw new BadRequestError(
        "title, description, caseId, assignedToId and dueDate are required",
      );
    }

    const result = await this.tasksService.createTask({
      ...req.body,
      firmId: req.firmId!,
      assignedById: req.adminId!,
    });
    res.status(201).json(result);
  });

  updateTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.tasksService.updateTask(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    res.status(200).json(result);
  });

  deleteTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.tasksService.deleteTask(req.params.id as string, req.firmId!);
    res.status(200).json({ message: "Task deleted" });
  });
}
