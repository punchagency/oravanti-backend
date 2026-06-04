/**
 * @openapi
 * tags:
 *   - name: Practice Areas
 *     description: Practice area catalog & firm subscriptions
 *
 * paths:
 *   /practice-areas/public:
 *     get:
 *       tags: [Practice Areas]
 *       summary: Get all practice areas (public)
 *       parameters:
 *         - in: query
 *           name: search
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Practice areas list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/PracticeArea"
 *
 *   /practice-areas/firm:
 *     get:
 *       tags: [Practice Areas]
 *       summary: Get practice areas with firm subscription status
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: search
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Firm practice areas
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/FirmPracticeArea"
 *
 *   /practice-areas/subscriptions:
 *     post:
 *       tags: [Practice Areas]
 *       summary: Subscribe a firm to practice areas
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateSubscriptionRequest"
 *       responses:
 *         201:
 *           description: Subscriptions created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *     patch:
 *       tags: [Practice Areas]
 *       summary: Cancel practice area subscriptions
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CancelSubscriptionRequest"
 *       responses:
 *         200:
 *           description: Subscriptions cancelled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { PracticeAreasController } from "./practice-areas.controller";

export class PracticeAreasRouter {
  public router: Router;
  public path: string;
  private practiceAreasController: PracticeAreasController;
  private validation: CommonValidation;

  constructor(
    practiceAreasController: PracticeAreasController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/practice-areas";
    this.practiceAreasController = practiceAreasController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.get("/public", this.practiceAreasController.getAllPracticeAreas);
    this.router.get(
      "/firm",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.practiceAreasController.getFirmPracticeAreas,
    );
    this.router.post(
      "/subscriptions",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.createSubscriptions,
    );
    this.router.patch(
      "/subscriptions/cancel",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.cancelSubscriptions,
    );
  }
}
