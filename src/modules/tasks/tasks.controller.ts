import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import * as tasksService from "./tasks.service";

export class TasksController {
  private tasksService: tasksService.TasksService;

  constructor(tasksService: tasksService.TasksService) {
    this.tasksService = tasksService;
  }

  getTaskStats = asyncWrap(async (req: AuthRequest, res: Response) => {
    const stats = await this.tasksService.getTaskStats(req.organizationId!);
    sendSuccess(res, stats, "Task stats retrieved successfully");
  });

  getAllTasks = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, status, priority, assignedToId } = req.query;

    const result = await this.tasksService.getAllTasks(req.organizationId!, {
      search: search as string,
      status: status as string,
      priority: priority as string,
      assignedToId: assignedToId as string,
    });
    sendSuccess(res, result, "Tasks retrieved successfully");
  });

  getTaskById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.tasksService.getTaskById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    sendSuccess(res, result, "Task retrieved successfully");
  });

  createTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.tasksService.createTask({
      ...req.body,
      organizationId: req.organizationId!,
      assignedById: req.adminId!,
    });
    sendSuccess(res, result, "Task created successfully", 201);
  });

  updateTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.tasksService.updateTask(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    sendSuccess(res, result, "Task updated successfully");
  });

  deleteTask = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.tasksService.deleteTask(req.params.id as string, req.organizationId!);
    sendSuccess(res, null, "Task deleted successfully");
  });
}
