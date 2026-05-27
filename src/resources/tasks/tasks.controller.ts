import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import * as tasksService from "./tasks.service";

export class TasksController {
  private tasksService: tasksService.TasksService;

  constructor(tasksService: tasksService.TasksService) {
    this.tasksService = tasksService;
  }

  getTaskStats = async (req: AuthRequest, res: Response) => {
    try {
      const stats = await this.tasksService.getTaskStats(req.firmId!);
      res.status(200).json(stats);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getAllTasks = async (req: AuthRequest, res: Response) => {
    const { search, status, priority, assignedToId } = req.query;
    try {
      const result = await this.tasksService.getAllTasks(req.firmId!, {
        search: search as string,
        status: status as string,
        priority: priority as string,
        assignedToId: assignedToId as string,
      });
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getTaskById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.tasksService.getTaskById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Task not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  createTask = async (req: AuthRequest, res: Response) => {
    const { title, description, caseId, assignedToId, dueDate } = req.body;

    if (!title || !description || !caseId || !assignedToId || !dueDate) {
      res.status(400).json({
        message:
          "title, description, caseId, assignedToId and dueDate are required",
      });
      return;
    }

    try {
      const result = await this.tasksService.createTask({
        ...req.body,
        firmId: req.firmId!,
        assignedById: req.adminId!,
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateTask = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.tasksService.updateTask(
        req.params.id as string,
        req.firmId!,
        req.body,
      );
      if (!result) {
        res.status(404).json({ message: "Task not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  deleteTask = async (req: AuthRequest, res: Response) => {
    try {
      await this.tasksService.deleteTask(req.params.id as string, req.firmId!);
      res.status(200).json({ message: "Task deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
