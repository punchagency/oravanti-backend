/**
 * @openapi
 * tags:
 *   - name: AI Error Detection
 *     description: AI-powered error detection & flags
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { AIErrorDetectionController } from "./ai-error-detection.controller";

export class AIErrorDetectionRouter {
  public router: Router;
  public path: string;
  private aiErrorDetectionController: AIErrorDetectionController;
  private validation: CommonValidation;

  constructor(
    aiErrorDetectionController: AIErrorDetectionController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/ai-error-detection";
    this.aiErrorDetectionController = aiErrorDetectionController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    /**
     * @openapi
     * /ai-error-detection/stats:
     *   get:
     *     tags: [AI Error Detection]
     *     summary: Get error detection statistics
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Error detection stats
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/AiErrorDetectionStats"
     */
    this.router.get("/stats", this.aiErrorDetectionController.getStats);

    /**
     * @openapi
     * /ai-error-detection/flags:
     *   get:
     *     tags: [AI Error Detection]
     *     summary: List all error flags
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: severity
     *         schema: { type: string, enum: [low, medium, high, critical] }
     *       - in: query
     *         name: status
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: List of error flags
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/AiErrorFlag"
     */
    this.router.get("/flags", this.aiErrorDetectionController.getAllFlags);

    /**
     * @openapi
     * /ai-error-detection/flags/{id}:
     *   get:
     *     tags: [AI Error Detection]
     *     summary: Get error flag by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Flag data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/AiErrorFlag"
     *       404: { description: Flag not found }
     */
    this.router.get(
      "/flags/:id",
      validateRequest({ params: this.validation.idParams }),
      this.aiErrorDetectionController.getFlagById,
    );

    /**
     * @openapi
     * /ai-error-detection/flags:
     *   post:
     *     tags: [AI Error Detection]
     *     summary: Create a new error flag
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateAiErrorFlagRequest"
     *     responses:
     *       201:
     *         description: Flag created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/AiErrorFlag"
     */
    this.router.post(
      "/flags",
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "caseId",
          "title",
          "description",
          "severity",
        ),
      }),
      this.aiErrorDetectionController.createFlag,
    );

    /**
     * @openapi
     * /ai-error-detection/flags/{id}/status:
     *   patch:
     *     tags: [AI Error Detection]
     *     summary: Update error flag status
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
     *             $ref: "#/components/schemas/UpdateFlagStatusRequest"
     *     responses:
     *       200:
     *         description: Flag status updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Flag not found }
     */
    this.router.patch(
      "/flags/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.aiErrorDetectionController.updateFlagStatus,
    );

    /**
     * @openapi
     * /ai-error-detection/system-config:
     *   get:
     *     tags: [AI Error Detection]
     *     summary: Get AI error detection system configuration
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: System configuration
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/AiSystemConfig"
     */
    this.router.get(
      "/system-config",
      this.aiErrorDetectionController.getSystemConfig,
    );

    /**
     * @openapi
     * /ai-error-detection/system-config:
     *   patch:
     *     tags: [AI Error Detection]
     *     summary: Update AI error detection system configuration
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/UpdateAiSystemConfigRequest"
     *     responses:
     *       200:
     *         description: Configuration updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.patch(
      "/system-config",
      validateRequest({ body: this.validation.optionalBody() }),
      this.aiErrorDetectionController.updateSystemConfig,
    );
  }
}
