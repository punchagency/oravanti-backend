import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import * as tasksService from "./tasks.service";

export class TasksController {
  private tasksService: tasksService.TasksService;

  constructor(tasksService: tasksService.TasksService) {
    this.tasksService = tasksService;
  }

  getTaskStats = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const stats = await this.tasksService.getTaskStats(organizationId!);
    sendSuccess(res, stats, "Task stats retrieved successfully");
  });

  getAllTasks = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { search, status, priority, assignedToId } = req.query;

    const result = await this.tasksService.getAllTasks(organizationId!, {
      search: search as string,
      status: status as string,
      priority: priority as string,
      assignedToId: assignedToId as string,
    });
    sendSuccess(res, result, "Tasks retrieved successfully");
  });

  getTaskById = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.tasksService.getTaskById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    sendSuccess(res, result, "Task retrieved successfully");
  });

  createTask = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.tasksService.createTask({
      ...req.body,
      organizationId: organizationId!,
      assignedById: staffId!,
    });
    sendSuccess(res, result, "Task created successfully", 201);
  });

  updateTask = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.tasksService.updateTask(
      req.params.id as string,
      organizationId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Task not found");
    }
    sendSuccess(res, result, "Task updated successfully");
  });

  deleteTask = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    await this.tasksService.deleteTask(req.params.id as string, organizationId!);
    sendSuccess(res, null, "Task deleted successfully");
  });
}
