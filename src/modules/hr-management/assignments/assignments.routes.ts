/**
 * @openapi
 * tags:
 *   - name: HR - Assignments
 *     description: Case assignments & contractor allocation
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

import { validateRequest } from "../../../middleware/validate.middleware";
import { AssignmentsController } from "./assignments.controller";

export class AssignmentsRouter {
  public router: Router;
  public path: string;
  private assignmentsController: AssignmentsController;
  private validation: CommonValidation;

  constructor(
    assignmentsController: AssignmentsController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/hr/assignments";
    this.assignmentsController = assignmentsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /hr/assignments/available-contractors:
     *   get:
     *     tags: [HR - Assignments]
     *     summary: Get available contractors for a filing type
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: filingType
     *         required: true
     *         schema:
     *           type: string
     *           enum: [I-130, I-485, I-765, I-140, N-400, I-131]
     *     responses:
     *       200:
     *         description: Available contractors list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Contractor"
     */
    this.router.get(
      "/available-contractors",
      validateRequest({
        query: this.validation.query({
          filingType: this.validation.enumValue([
            "I-130",
            "I-485",
            "I-765",
            "I-140",
            "N-400",
            "I-131",
          ]),
        }),
      }),
      this.assignmentsController.getAvailableContractors,
    );

    /**
     * @openapi
     * /hr/assignments/:
     *   get:
     *     tags: [HR - Assignments]
     *     summary: List all assignments
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Assignments list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Assignment"
     */
    this.router.get("/", this.assignmentsController.getAllAssignments);

    /**
     * @openapi
     * /hr/assignments/{id}:
     *   get:
     *     tags: [HR - Assignments]
     *     summary: Get assignment by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Assignment data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Assignment"
     *       404: { description: Assignment not found }
     */
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.assignmentsController.getAssignmentById,
    );

    /**
     * @openapi
     * /hr/assignments/:
     *   post:
     *     tags: [HR - Assignments]
     *     summary: Assign a case to a team or contractor
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateAssignmentRequest"
     *     responses:
     *       201:
     *         description: Assignment created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Assignment"
     */
    this.router.post(
      "/",
      validateRequest({
        body: this.validation
          .requiredBody("assignmentType", "urgencyLevel")
          .extend({
            filingType: this.validation.enumValue([
              "I-130",
              "I-485",
              "I-765",
              "I-140",
              "N-400",
              "I-131",
            ]),
          }),
      }),
      this.assignmentsController.assignCase,
    );

    /**
     * @openapi
     * /hr/assignments/{id}/status:
     *   patch:
     *     tags: [HR - Assignments]
     *     summary: Update assignment status
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateAssignmentStatusRequest"
     *     responses:
     *       200:
     *         description: Assignment status updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Assignment not found }
     */
    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.assignmentsController.updateAssignmentStatus,
    );
  }
}
