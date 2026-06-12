/**
 * @openapi
 * tags:
 *   - name: Settings - Access Control
 *     description: Role-based access control & certification gates
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { CertificationGatesController } from "../certification-gates/certification-gates.controller";
import { AccessControlController } from "./access-control.controller";

export class AccessControlRouter {
  public router: Router;
  public path: string;
  private accessControlController: AccessControlController;
  private certificationGatesController: CertificationGatesController;
  private validation: CommonValidation;

  constructor(
    accessControlController: AccessControlController,
    certificationGatesController: CertificationGatesController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/access-control";
    this.accessControlController = accessControlController;
    this.certificationGatesController = certificationGatesController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    /**
     * @openapi
     * /settings/access-control/overview:
     *   get:
     *     tags: [Settings - Access Control]
     *     summary: Get role overview (member counts per role)
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Role overview
     */
    this.router.get("/overview", this.accessControlController.getRoleOverview);

    /**
     * @openapi
     * /settings/access-control/permissions:
     *   get:
     *     tags: [Settings - Access Control]
     *     summary: Get module permissions grouped by module & role
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Permissions matrix
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/ModulePermission"
     */
    this.router.get(
      "/permissions",
      this.accessControlController.getPermissions,
    );

    /**
     * @openapi
     * /settings/access-control/permissions:
     *   post:
     *     tags: [Settings - Access Control]
     *     summary: Save module permissions
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/SavePermissionsRequest"
     *     responses:
     *       200:
     *         description: Permissions saved
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/permissions",
      validateRequest({ body: this.validation.requiredArrayBody("permissions") }),
      this.accessControlController.savePermissions,
    );

    /**
     * @openapi
     * /settings/access-control/certification-gates:
     *   get:
     *     tags: [Settings - Access Control]
     *     summary: Get certification gate rules
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Certification gate rules
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/ParalegalCertificationGate"
     */
    this.router.get(
      "/certification-gates",
      this.certificationGatesController.getCertificationGates,
    );

    /**
     * @openapi
     * /settings/access-control/certification-gates:
     *   post:
     *     tags: [Settings - Access Control]
     *     summary: Update certification gate rules
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateCertificationGatesRequest"
     *     responses:
     *       200:
     *         description: Gates updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/certification-gates",
      validateRequest({ body: this.validation.requiredArrayBody("gates") }),
      this.certificationGatesController.updateCertificationGates,
    );

    /**
     * @openapi
     * /settings/access-control/activation-requirements:
     *   get:
     *     tags: [Settings - Access Control]
     *     summary: Get staff activation requirements
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Activation requirements
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/ParalegalActivationRequirement"
     */
    this.router.get(
      "/activation-requirements",
      this.certificationGatesController.getActivationRequirements,
    );

    /**
     * @openapi
     * /settings/access-control/activation-requirements:
     *   post:
     *     tags: [Settings - Access Control]
     *     summary: Update staff activation requirements
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateActivationRequirementsRequest"
     *     responses:
     *       200:
     *         description: Requirements updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/activation-requirements",
      validateRequest({
        body: this.validation.arrayBody("certificationCodes"),
      }),
      this.certificationGatesController.updateActivationRequirements,
    );
  }
}
