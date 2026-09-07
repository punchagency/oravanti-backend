/**
 * @openapi
 * tags:
 *   - name: Settings - Financial Access
 *     description: Financial data access controls
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { requirePermission } from "../../../middleware/permission.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

import { validateRequest } from "../../../middleware/validate.middleware";
import { FinancialAccessController } from "./financial-access.controller";

export class FinancialAccessRouter {
  public router: Router;
  public path: string;
  private financialAccessController: FinancialAccessController;
  private validation: CommonValidation;

  constructor(
    financialAccessController: FinancialAccessController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/financial-access";
    this.financialAccessController = financialAccessController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);
    /**
     * Deciding who may see and touch trust money is a firm-configuration act,
     * not an operational one — the same class as connecting the payment
     * processor, and gated the same way.
     *
     * This route had no permission at all, so any authenticated member of the
     * firm could grant themselves IOLTA access. `configure` rather than
     * `update`, deliberately: `update` is invoice editing, and widening who may
     * edit an invoice must never silently widen who may re-cut this matrix.
     */
    this.router.use(requirePermission({ finance: ["configure"] }));

    /**
     * @openapi
     * /settings/financial-access/:
     *   get:
     *     tags: [Settings - Financial Access]
     *     summary: Get financial access controls
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Financial access controls grouped by account type & role
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/FinancialAccessControl"
     */
    this.router.get("/", this.financialAccessController.getFinancialAccess);

    /**
     * @openapi
     * /settings/financial-access/:
     *   patch:
     *     tags: [Settings - Financial Access]
     *     summary: Update financial access controls
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateFinancialAccessRequest"
     *     responses:
     *       200:
     *         description: Controls updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("controls") }),
      this.financialAccessController.updateFinancialAccess,
    );
  }
}
