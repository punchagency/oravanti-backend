/**
 * @openapi
 * tags:
 *   - name: Settings - Approval Workflows
 *     description: Approval workflow configuration
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

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
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /settings/approval-workflows/:
     *   get:
     *     tags: [Settings - Approval Workflows]
     *     summary: Get approval workflow configurations
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Workflow configurations
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/ApprovalWorkflow"
     */
    this.router.get("/", this.approvalWorkflowsController.getApprovalWorkflows);

    /**
     * @openapi
     * /settings/approval-workflows/:
     *   patch:
     *     tags: [Settings - Approval Workflows]
     *     summary: Update approval workflow configurations
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateApprovalWorkflowRequest"
     *     responses:
     *       200:
     *         description: Workflows updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("workflows") }),
      this.approvalWorkflowsController.updateApprovalWorkflows,
    );
  }
}
