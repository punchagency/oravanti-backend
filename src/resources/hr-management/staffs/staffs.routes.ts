/**
 * @openapi
 * tags:
 *   - name: HR - Staff
 *     description: Staff management
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { StaffController } from "./staffs.controller";

export class StaffRouter {
  public router: Router;
  public path: string;
  private staffController: StaffController;
  private validation: CommonValidation;

  constructor(staffController: StaffController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/hr/staff";
    this.staffController = staffController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    /**
     * @openapi
     * /hr/staff/:
     *   get:
     *     tags: [HR - Staff]
     *     summary: List all staff members
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Staff list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Staff"
     */
    this.router.get("/", this.staffController.getAll);

    /**
     * @openapi
     * /hr/staff/{id}:
     *   get:
     *     tags: [HR - Staff]
     *     summary: Get staff by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Staff data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Staff"
     *       404: { description: Staff not found }
     */
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.staffController.getById,
    );

    /**
     * @openapi
     * /hr/staff/:
     *   post:
     *     tags: [HR - Staff]
     *     summary: Add a new staff member
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateStaffRequest"
     *     responses:
     *       201:
     *         description: Staff created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Staff"
     */
    this.router.post(
      "/",
      validateRequest({
        body: this.validation.requiredBody(
          "firstName",
          "lastName",
          "email",
          "phone",
          "role",
          "teamId",
          "startDate",
        ),
      }),
      this.staffController.addStaff,
    );

    /**
     * @openapi
     * /hr/staff/{id}:
     *   patch:
     *     tags: [HR - Staff]
     *     summary: Update a staff member
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
     *             $ref: "#/components/schemas/UpdateStaffRequest"
     *     responses:
     *       200:
     *         description: Staff updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Staff"
     *       404: { description: Staff not found }
     */
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.staffController.updateStaff,
    );

    /**
     * @openapi
     * /hr/staff/{id}:
     *   delete:
     *     tags: [HR - Staff]
     *     summary: Delete a staff member
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Staff deleted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Staff not found }
     */
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.staffController.deleteStaff,
    );
  }
}
