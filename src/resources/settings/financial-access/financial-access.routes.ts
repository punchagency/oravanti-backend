/**
 * @openapi
 * tags:
 *   - name: Settings - Financial Access
 *     description: Financial data access controls
 *
 * paths:
 *   /settings/financial-access/:
 *     get:
 *       tags: [Settings - Financial Access]
 *       summary: Get financial access controls
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Financial access controls grouped by account type & role
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/FinancialAccessControl"
 *     patch:
 *       tags: [Settings - Financial Access]
 *       summary: Update financial access controls
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateFinancialAccessRequest"
 *       responses:
 *         200:
 *           description: Controls updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
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
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.financialAccessController.getFinancialAccess);
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("controls") }),
      this.financialAccessController.updateFinancialAccess,
    );
  }
}
