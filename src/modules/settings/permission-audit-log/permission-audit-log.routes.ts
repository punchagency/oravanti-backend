/**
 * @openapi
 * tags:
 *   - name: Settings - Audit Log
 *     description: Permission change audit log
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { CommonValidation } from "../../../validation/common.validation";

import { validateRequest } from "../../../middleware/validate.middleware";
import { PermissionAuditLogController } from "./permission-audit-log.controller";

export class PermissionAuditLogRouter {
  public router: Router;
  public path: string;
  private auditLogController: PermissionAuditLogController;
  private validation: CommonValidation;

  constructor(
    auditLogController: PermissionAuditLogController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/permission-audit-log";
    this.auditLogController = auditLogController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /settings/permission-audit-log/:
     *   get:
     *     tags: [Settings - Audit Log]
     *     summary: Get permission audit log entries
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: limit
     *         schema:
     *           type: integer
     *           default: 20
     *     responses:
     *       200:
     *         description: Audit log entries
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Pagination"
     */
    this.router.get(
      "/",
      validateRequest({
        query: this.validation.query({
          limit: this.validation.nonEmptyString.optional(),
        }),
      }),
      this.auditLogController.getPermissionAuditLog,
    );
  }
}
