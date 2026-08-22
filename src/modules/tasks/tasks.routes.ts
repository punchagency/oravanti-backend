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
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
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

    this.router.get("/stats", this.tasksController.getTaskStats);
    this.router.get("/", this.tasksController.getAllTasks);
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.tasksController.getTaskById,
    );
    this.router.post(
      "/",
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
      validateRequest({
        params: v.taskIdParams,
        body: v.updateTaskBody,
      }),
      this.tasksController.updateTask,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.tasksController.deleteTask,
    );
  }
}
