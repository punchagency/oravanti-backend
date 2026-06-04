/**
 * @openapi
 * tags:
 *   - name: Settings - Approval Workflows
 *     description: Approval workflow configuration
 *
 * paths:
 *   /settings/approval-workflows/:
 *     get:
 *       tags: [Settings - Approval Workflows]
 *       summary: Get approval workflow configurations
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Workflow configurations
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/ApprovalWorkflow"
 *     patch:
 *       tags: [Settings - Approval Workflows]
 *       summary: Update approval workflow configurations
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateApprovalWorkflowRequest"
 *       responses:
 *         200:
 *           description: Workflows updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
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
