import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { ApprovalWorkflowsController } from "./approval-workflows.controller";

export class ApprovalWorkflowsRouter {
  public router: Router;
  public path: string;
  private approvalWorkflowsController: ApprovalWorkflowsController;
  private validation: CommonValidation;

  constructor(
    approvalWorkflowsController: ApprovalWorkflowsController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/approval-workflows";
    this.approvalWorkflowsController = approvalWorkflowsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.approvalWorkflowsController.getApprovalWorkflows);
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("workflows") }),
      this.approvalWorkflowsController.updateApprovalWorkflows,
    );
  }
}
