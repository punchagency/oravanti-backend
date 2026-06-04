/**
 * @openapi
 * tags:
 *   - name: Settings - Data Access
 *     description: Data access control settings
 *
 * paths:
 *   /settings/data-access/:
 *     get:
 *       tags: [Settings - Data Access]
 *       summary: Get data access controls
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Data access controls grouped by data type & role
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/DataAccessControl"
 *     patch:
 *       tags: [Settings - Data Access]
 *       summary: Update data access controls
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateDataAccessRequest"
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
import { DataAccessController } from "./data-access.controller";

export class DataAccessRouter {
  public router: Router;
  public path: string;
  private dataAccessController: DataAccessController;
  private validation: CommonValidation;

  constructor(
    dataAccessController: DataAccessController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/data-access";
    this.dataAccessController = dataAccessController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.dataAccessController.getDataAccessControls);
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("controls") }),
      this.dataAccessController.updateDataAccessControls,
    );
  }
}
