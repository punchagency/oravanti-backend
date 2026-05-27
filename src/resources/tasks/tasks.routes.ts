import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { TasksController } from "./tasks.controller";

export class TasksRouter {
  public router: Router;
  public path: string;
  private tasksController: TasksController;

  constructor(taskController: TasksController) {
    this.router = Router();
    this.path = "/tasks";
    this.tasksController = taskController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.tasksController.getTaskStats);
    this.router.get("/", this.tasksController.getAllTasks);
    this.router.get("/:id", this.tasksController.getTaskById);
    this.router.post("/", this.tasksController.createTask);
    this.router.patch("/:id", this.tasksController.updateTask);
    this.router.delete("/:id", this.tasksController.deleteTask);
  }
}
