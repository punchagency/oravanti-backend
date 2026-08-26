import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import {
  emptyTaskCounts,
  getMyTasks,
  getReviewQueue,
  type TaskQueueParams,
  type TaskSource,
} from "./task-queue.service";
import {
  assignableStaffForTask,
  assignTask,
  getReviewThread,
  transitionTask,
  type TaskTransition,
} from "./task-transitions.service";
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
    const { search, status, priority, assignedToId, caseId, leadId, source } = req.query;

    const result = await this.tasksService.getAllTasks(organizationId!, {
      search: search as string,
      status: status as string,
      priority: priority as string,
      assignedToId: assignedToId as string,
      caseId: caseId as string,
      leadId: leadId as string,
      source: source as "workflow" | "pipeline" | "ad_hoc",
    });
    sendSuccess(res, result, "Tasks retrieved successfully");
  });

  // ─── Cross-entity lists ───────────────────────────────────────────────────
  // Both read the same rows in the same shape; the only difference is whose
  // tasks and which statuses by default. See task-queue.service.ts.

  private queueParams(req: Request): TaskQueueParams {
    const { organizationId } = getRequestContext();
    const { source, status, page, limit } = req.query;
    return {
      organizationId: organizationId!,
      source: (source as TaskSource) ?? "workflow",
      status: status as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    };
  }

  getReviewQueue = asyncWrap(async (req: Request, res: Response) => {
    const result = await getReviewQueue(this.queueParams(req));
    sendSuccess(res, result.items, "Review queue retrieved", 200, {
      pagination: result.pagination,
      counts: result.counts,
    });
  });

  getMyTasks = asyncWrap(async (req: Request, res: Response) => {
    const { staffId } = getRequestContext();
    // A caller with no staff record can hold no assignment, so there is nothing
    // to query for. Guarding here keeps `assignedToId` non-optional below, where
    // an accidental undefined would widen the query to the whole firm.
    if (!staffId) {
      sendSuccess(res, [], "Tasks retrieved", 200, {
        pagination: { total: 0, limit: 0, offset: 0, page: 1 },
        counts: emptyTaskCounts(),
      });
      return;
    }
    const result = await getMyTasks({
      ...this.queueParams(req),
      assignedToId: staffId,
    });
    sendSuccess(res, result.items, "Tasks retrieved", 200, {
      pagination: result.pagination,
      counts: result.counts,
    });
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
    const { organizationId, staffId } = getRequestContext();
    const result = await this.tasksService.updateTask(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId,
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

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  // One handler per verb rather than a `:transition` path parameter: the verb is
  // part of the route's identity, and a typo in a URL should 404 rather than
  // reach the service with an unknown transition.

  private transition = (transition: TaskTransition, message: string) =>
    asyncWrap(async (req: Request, res: Response) => {
      const { organizationId, staffId } = getRequestContext();
      const task = await transitionTask({
        taskId: req.params.id as string,
        organizationId: organizationId!,
        transition,
        actorStaffId: staffId,
        note: req.body?.note,
      });
      sendSuccess(res, task, message);
    });

  startTask = this.transition("start", "Task started");
  completeTask = this.transition("complete", "Task completed");
  submitTaskForReview = this.transition("submit", "Task submitted for review");
  approveTask = this.transition("approve", "Task approved");
  rejectTask = this.transition("reject", "Task rejected");
  reopenTask = this.transition("reopen", "Task reopened");

  getTaskReviewThread = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const events = await getReviewThread(req.params.id as string, organizationId!);
    sendSuccess(res, events, "Task review thread retrieved");
  });

  getAssignableStaff = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const people = await assignableStaffForTask(req.params.id as string, organizationId!);
    sendSuccess(res, people, "Assignable staff retrieved");
  });

  assignTask = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const task = await assignTask({
      taskId: req.params.id as string,
      assignedToId: req.body.assignedToId,
      organizationId: organizationId!,
      actorStaffId: staffId,
      overrideRationale: req.body.overrideRationale,
    });
    sendSuccess(res, task, "Task assigned");
  });
}
