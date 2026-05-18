import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as tasksService from '../../services/tasks/tasks.service';

export const getTaskStats = async (req: AuthRequest, res: Response) => {
  try {
    const stats = await tasksService.getTaskStats(req.firmId!);
    res.status(200).json(stats);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getAllTasks = async (req: AuthRequest, res: Response) => {
  const { search, status, priority, assignedToId } = req.query;
  try {
    const result = await tasksService.getAllTasks(req.firmId!, {
      search:       search       as string,
      status:       status       as string,
      priority:     priority     as string,
      assignedToId: assignedToId as string,
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getTaskById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await tasksService.getTaskById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Task not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const createTask = async (req: AuthRequest, res: Response) => {
  const { title, description, caseId, assignedToId, dueDate } = req.body;

  if (!title || !description || !caseId || !assignedToId || !dueDate) {
    res.status(400).json({
      message: 'title, description, caseId, assignedToId and dueDate are required',
    });
    return;
  }

  try {
    const result = await tasksService.createTask({
      ...req.body,
      firmId:       req.firmId!,
      assignedById: req.adminId!,
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const result = await tasksService.updateTask(req.params.id as string, req.firmId!, req.body);
    if (!result) { res.status(404).json({ message: 'Task not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
  try {
    await tasksService.deleteTask(req.params.id as string, req.firmId!);
    res.status(200).json({ message: 'Task deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
