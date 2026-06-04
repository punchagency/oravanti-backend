import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { TasksController } from "./tasks.controller";

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
    this.router.use(requireAuth, requireAdmin, setFirmContext);

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
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
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
