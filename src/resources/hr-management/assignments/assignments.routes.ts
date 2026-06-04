/**
 * @openapi
 * tags:
 *   - name: HR - Assignments
 *     description: Case assignments & contractor allocation
 *
 * paths:
 *   /hr/assignments/available-contractors:
 *     get:
 *       tags: [HR - Assignments]
 *       summary: Get available contractors for a filing type
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: filingType
 *           required: true
 *           schema:
 *             type: string
 *             enum: [I-130, I-485, I-765, I-140, N-400, I-131]
 *       responses:
 *         200:
 *           description: Available contractors list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Contractor"
 *
 *   /hr/assignments/:
 *     get:
 *       tags: [HR - Assignments]
 *       summary: List all assignments
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Assignments list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Assignment"
 *     post:
 *       tags: [HR - Assignments]
 *       summary: Assign a case to a team or contractor
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateAssignmentRequest"
 *       responses:
 *         201:
 *           description: Assignment created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Assignment"
 *
 *   /hr/assignments/{id}:
 *     get:
 *       tags: [HR - Assignments]
 *       summary: Get assignment by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Assignment data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Assignment"
 *         404: { description: Assignment not found }
 *
 *   /hr/assignments/{id}/status:
 *     patch:
 *       tags: [HR - Assignments]
 *       summary: Update assignment status
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
 *               $ref: "#/components/schemas/UpdateAssignmentStatusRequest"
 *       responses:
 *         200:
 *           description: Assignment status updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *         404: { description: Assignment not found }
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { AssignmentsController } from "./assignments.controller";

export class AssignmentsRouter {
  public router: Router;
  public path: string;
  private assignmentsController: AssignmentsController;

  constructor(assignmentsController: AssignmentsController) {
    this.router = Router();
    this.path = "/hr/assignments";
    this.assignmentsController = assignmentsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/available-contractors",
      this.assignmentsController.getAvailableContractors,
    );
    this.router.get("/", this.assignmentsController.getAllAssignments);
    this.router.get("/:id", this.assignmentsController.getAssignmentById);
    this.router.post("/", this.assignmentsController.assignCase);
    this.router.patch(
      "/:id/status",
      this.assignmentsController.updateAssignmentStatus,
    );
  }
}
