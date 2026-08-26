/**
 * @openapi
 * tags:
 *   - name: Tasks
 *     description: Task management
 *
 * paths:
 *   /tasks/stats:
 *     get:
 *       tags: [Tasks]
 *       summary: Get task statistics
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Task stats
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/TaskStats"
 *
 *   /tasks/review-queue:
 *     get:
 *       tags: [Tasks]
 *       summary: Tasks awaiting or having been through review
 *       description: >
 *         One queue for intake steps and case workflow steps — pass `source` to
 *         pick which. Every row carries the full context a reviewer needs (whose
 *         matter or lead, who submitted it, when, what phase) plus the latest
 *         rejection note. Defaults to in_review, rejected and completed. Counts
 *         cover every status regardless of what is listed, so tab badges stay
 *         right on the tab you are not looking at.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: source
 *           schema: { type: string, enum: [workflow, pipeline, ad_hoc] }
 *         - in: query
 *           name: status
 *           description: Comma-separated. Unknown values are ignored.
 *           schema: { type: string }
 *         - in: query
 *           name: page
 *           schema: { type: integer }
 *         - in: query
 *           name: limit
 *           schema: { type: integer }
 *       responses:
 *         200: { description: Review queue with pagination and per-status counts }
 *
 *   /tasks/my-tasks:
 *     get:
 *       tags: [Tasks]
 *       summary: The caller's own tasks
 *       description: >
 *         The review queue narrowed to the caller, in the same row shape — so one
 *         card component serves both, and the submitter sees exactly the context
 *         and history the reviewer does. No status filter by default.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: source
 *           schema: { type: string, enum: [workflow, pipeline, ad_hoc] }
 *         - in: query
 *           name: status
 *           description: Comma-separated. Unknown values are ignored.
 *           schema: { type: string }
 *         - in: query
 *           name: page
 *           schema: { type: integer }
 *         - in: query
 *           name: limit
 *           schema: { type: integer }
 *       responses:
 *         200: { description: Task list with pagination and per-status counts }
 *
 *   /tasks/:
 *     get:
 *       tags: [Tasks]
 *       summary: List all tasks (filterable)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: search
 *           schema: { type: string }
 *         - in: query
 *           name: status
 *           schema: { type: string }
 *         - in: query
 *           name: priority
 *           schema: { type: string, enum: [low, medium, high] }
 *         - in: query
 *           name: assignedToId
 *           schema: { type: string }
 *         - in: query
 *           name: page
 *           schema: { type: integer }
 *         - in: query
 *           name: limit
 *           schema: { type: integer }
 *       responses:
 *         200:
 *           description: Paginated task list
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Pagination"
 *     post:
 *       tags: [Tasks]
 *       summary: Create a new task
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateTaskRequest"
 *       responses:
 *         201:
 *           description: Task created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Task"
 *
 *   /tasks/{id}:
 *     get:
 *       tags: [Tasks]
 *       summary: Get task by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Task data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Task"
 *         404: { description: Task not found }
 *     patch:
 *       tags: [Tasks]
 *       summary: Update a task
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateTaskRequest"
 *       responses:
 *         200:
 *           description: Task updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Task"
 *         404: { description: Task not found }
 *     delete:
 *       tags: [Tasks]
 *       summary: Delete a task
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Task deleted
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /tasks/{id}/complete:
 *     post:
 *       tags: [Tasks]
 *       summary: Complete a task
 *       description: >
 *         Works for any task — intake step, case workflow step or ad-hoc to-do.
 *         A workflow-sourced task also gets its case timeline entry and elapsed
 *         time; a lead-attached one gets its lead timeline entry.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 note: { type: string }
 *       responses:
 *         200: { description: Task completed }
 *         400: { description: The task is not in a status this verb allows }
 *
 *   /tasks/{id}/start:
 *     post:
 *       tags: [Tasks]
 *       summary: Start a task (pending → in_progress)
 *       description: >
 *         The assignee saying they have picked the task up. A task is assigned
 *         as `pending` and only this moves it — being given work is not the same
 *         as beginning it, so nothing stamps `in_progress` on someone's behalf.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Task started }
 *         400: { description: The task has already been started }
 *
 *   /tasks/{id}/submit-review:
 *     post:
 *       tags: [Tasks]
 *       summary: Submit a task for review (in_progress or rejected → in_review)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Task submitted }
 *         400: { description: The task is not in a status this verb allows }
 *
 *   /tasks/{id}/approve:
 *     post:
 *       tags: [Tasks]
 *       summary: Approve a task in review (in_review → completed)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Task approved }
 *         400: { description: The task is not in a status this verb allows }
 *
 *   /tasks/{id}/reject:
 *     post:
 *       tags: [Tasks]
 *       summary: Reject a task in review (in_review → rejected)
 *       description: The note is required here — it is the feedback the assignee acts on.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [note]
 *               properties:
 *                 note: { type: string }
 *       responses:
 *         200: { description: Task rejected }
 *         400: { description: Not in review, or no feedback given }
 *
 *   /tasks/{id}/reopen:
 *     post:
 *       tags: [Tasks]
 *       summary: Put a closed task back in progress
 *       description: >
 *         From rejected, completed or skipped → in_progress. Completed and
 *         skipped are included because work gets marked done in error, or
 *         skipped and later turns out to matter; without a way back the firm is
 *         left with a wrong record or a duplicate task beside it. The move is
 *         audited like any other.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Task reopened }
 *         400: { description: The task is not in a status this verb allows }
 *
 *   /tasks/{id}/assignable-staff:
 *     get:
 *       tags: [Tasks]
 *       summary: Everyone this task may be handed to
 *       description: >
 *         A case task draws from the team the case is assigned to and nowhere
 *         else; an intake step, which hangs off a lead and has no team, draws
 *         from the firm. `PATCH /tasks/{id}/assign` enforces the same pool.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: "Staff: id, name, role" }
 *
 *   /tasks/{id}/assign:
 *     patch:
 *       tags: [Tasks]
 *       summary: Hand a task to a specific staff member
 *       description: >
 *         Available in any status. Auto-assignment by role is a default, not a
 *         lock — but the pool is not: a case task can only go to someone on the
 *         case's team. Reassigning a locked workflow step needs an
 *         overrideRationale.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [assignedToId]
 *               properties:
 *                 assignedToId: { type: string, format: uuid }
 *                 overrideRationale: { type: string }
 *       responses:
 *         200: { description: Task assigned }
 *
 *   /tasks/{id}/review-thread:
 *     get:
 *       tags: [Tasks]
 *       summary: The task's submit/approve/reject/reopen note history, oldest first
 *       description: >
 *         Each entry carries the registry `action` (e.g. "task.rejected") and its
 *         `label`. Render the label; never re-case the action into a display
 *         string, and always have a fallback for an action this build predates.
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Review thread }
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { CommonValidation } from "../../validation/common.validation";

import { validateRequest } from "../../middleware/validate.middleware";
import { TasksController } from "./tasks.controller";
import * as v from "./tasks.validation";

export class TasksRouter {
  public router: Router;
  public path: string;
  private tasksController: TasksController;
  private validation: CommonValidation;

  constructor(taskController: TasksController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/tasks";
    this.tasksController = taskController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // `tasks` is its own permission resource rather than riding on `cases`:
    // a paralegal holds only `cases:view_assigned` yet performs most of the
    // workflow steps, so gating writes here on `cases:update` would lock the
    // engine's primary user out of their own queue. See auth/permissions.ts.
    this.router.get("/stats", requirePermission("tasks", "read"), this.tasksController.getTaskStats);
    // Static paths — must precede `/:id`.
    this.router.get(
      "/review-queue",
      requirePermission("tasks", "read"),
      this.tasksController.getReviewQueue,
    );
    // Only `tasks:read` — this is already scoped to the caller's own rows, so a
    // narrower permission would only lock people out of their own to-do list.
    this.router.get(
      "/my-tasks",
      requirePermission("tasks", "read"),
      this.tasksController.getMyTasks,
    );
    this.router.get("/", requirePermission("tasks", "read"), this.tasksController.getAllTasks);
    this.router.get(
      "/:id",
      requirePermission("tasks", "read"),
      validateRequest({ params: this.validation.idParams }),
      this.tasksController.getTaskById,
    );
    this.router.post(
      "/",
      requirePermission("tasks", "create"),
      validateRequest({
        body: this.validation.requiredBody(
          "title",
          "description",
          "caseId",
          "assignedToId",
          "dueDate",
        ),
      }),
      this.tasksController.createTask,
    );
    this.router.patch(
      "/:id",
      requirePermission("tasks", "update"),
      validateRequest({
        params: v.taskIdParams,
        body: v.updateTaskBody,
      }),
      this.tasksController.updateTask,
    );
    this.router.delete(
      "/:id",
      requirePermission("tasks", "delete"),
      validateRequest({ params: this.validation.idParams }),
      this.tasksController.deleteTask,
    );

    // ─── Lifecycle ──────────────────────────────────────────────────────────
    // The one place a task moves through its lifecycle, whatever it hangs off:
    // an intake step, a case workflow step, or an ad-hoc to-do. The route does
    // not name the source, and the service dispatches on it. Reviewing is a
    // task update, so all six sit behind `tasks:update` — the review verbs are
    // additionally gated by status, which is the real control here: only a task
    // someone submitted can be approved.
    const transitions = [
      ["start", this.tasksController.startTask],
      ["complete", this.tasksController.completeTask],
      ["submit-review", this.tasksController.submitTaskForReview],
      ["approve", this.tasksController.approveTask],
      ["reject", this.tasksController.rejectTask],
      ["reopen", this.tasksController.reopenTask],
    ] as const;

    for (const [verb, handler] of transitions) {
      this.router.post(
        `/:id/${verb}`,
        requirePermission("tasks", "update"),
        validateRequest({ params: v.taskIdParams, body: v.taskTransitionBody }),
        handler,
      );
    }

    this.router.patch(
      "/:id/assign",
      requirePermission("tasks", "update"),
      validateRequest({ params: v.taskIdParams, body: v.assignTaskBody }),
      this.tasksController.assignTask,
    );

    this.router.get(
      "/:id/review-thread",
      requirePermission("tasks", "read"),
      validateRequest({ params: v.taskIdParams }),
      this.tasksController.getTaskReviewThread,
    );

    this.router.get(
      "/:id/assignable-staff",
      requirePermission("tasks", "read"),
      validateRequest({ params: v.taskIdParams }),
      this.tasksController.getAssignableStaff,
    );
  }
}
