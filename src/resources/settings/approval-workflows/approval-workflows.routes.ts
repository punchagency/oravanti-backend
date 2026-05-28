import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { ApprovalWorkflowsController } from "./approval-workflows.controller";

export class ApprovalWorkflowsRouter {
  public router: Router;
  public path: string;
  private approvalWorkflowsController: ApprovalWorkflowsController;

  constructor(approvalWorkflowsController: ApprovalWorkflowsController) {
    this.router = Router();
    this.path = "/settings/approval-workflows";
    this.approvalWorkflowsController = approvalWorkflowsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.approvalWorkflowsController.getApprovalWorkflows);
    this.router.patch(
      "/",
      this.approvalWorkflowsController.updateApprovalWorkflows,
    );
  }
}
