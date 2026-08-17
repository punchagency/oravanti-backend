/**
 * @openapi
 * tags:
 *   - name: Settings - Firm Info
 *     description: Law firm information & settings
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

import { validateRequest } from "../../../middleware/validate.middleware";
import { FirmInfoController } from "./firm-info.controller";

export class FirmInfoRouter {
  public router: Router;
  public path: string;
  private firmInfoController: FirmInfoController;
  private validation: CommonValidation;

  constructor(
    firmInfoController: FirmInfoController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/firm-info";
    this.firmInfoController = firmInfoController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /settings/firm-info/:
     *   get:
     *     tags: [Settings - Firm Info]
     *     summary: Get firm information
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Firm info data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/FirmInfo"
     *       404: { description: Firm info not found }
     */
    this.router.get("/", this.firmInfoController.getFirmInfo);

    /**
     * @openapi
     * /settings/firm-info/:
     *   post:
     *     tags: [Settings - Firm Info]
     *     summary: Create or update firm information
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateFirmInfoRequest"
     *     responses:
     *       200:
     *         description: Firm info saved
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/FirmInfo"
     */
    this.router.post(
      "/",
      validateRequest({ body: this.validation.requiredBody("firmName", "firmEmail") }),
      this.firmInfoController.upsertFirmInfo,
    );
  }
}
