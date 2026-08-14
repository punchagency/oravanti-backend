/**
 * @openapi
 * tags:
 *   - name: Practice Areas
 *     description: Practice area catalog & firm subscriptions
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { CommonValidation } from "../../validation/common.validation";


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
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /practice-areas/public:
     *   get:
     *     tags: [Practice Areas]
     *     summary: Get all practice areas (public)
     *     parameters:
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Practice areas list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/PracticeArea"
     */
    this.router.get("/public", this.practiceAreasController.getAllPracticeAreas);

    /**
     * @openapi
     * /practice-areas/firm:
     *   get:
     *     tags: [Practice Areas]
     *     summary: Get practice areas with firm subscription status
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Firm practice areas
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/FirmPracticeArea"
     */
    this.router.get(
      "/firm",
      requireAuth,
      this.practiceAreasController.getFirmPracticeAreas,
    );

    /**
     * @openapi
     * /practice-areas/subscriptions:
     *   post:
     *     tags: [Practice Areas]
     *     summary: Subscribe a firm to practice areas
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateSubscriptionRequest"
     *     responses:
     *       201:
     *         description: Subscriptions created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/subscriptions",
      requireAuth,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.createSubscriptions,
    );

    /**
     * @openapi
     * /practice-areas/subscriptions:
     *   patch:
     *     tags: [Practice Areas]
     *     summary: Cancel practice area subscriptions
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CancelSubscriptionRequest"
     *     responses:
     *       200:
     *         description: Subscriptions cancelled
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.patch(
      "/subscriptions/cancel",
      requireAuth,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.cancelSubscriptions,
    );

    /**
     * @openapi
     * /practice-areas/tree-data:
     *   get:
     *     tags: [Practice Areas]
     *     summary: Practice area taxonomy as a nested tree
     *     description: >
     *       Scoped to the practice areas the caller's firm actively subscribes
     *       to, falling back to the full taxonomy when it subscribes to none.
     *       Leaf nodes omit `children` rather than carrying an empty array.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: practiceAreaIds
     *         schema: { type: string }
     *         description: Comma-separated ids; returns only those subtrees.
     *       - in: query
     *         name: depth
     *         schema: { type: integer, enum: [1, 2, 3], default: 3 }
     *         description: >
     *           1 = practice areas only, 2 = + subcategories, 3 = + case types.
     *           Lower depths skip the corresponding queries entirely.
     *     responses:
     *       200:
     *         description: Tree data retrieved
     */
    this.router.get("/tree-data", this.practiceAreasController.getTreeData);
  }
}
