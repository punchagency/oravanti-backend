/**
 * @openapi
 * tags:
 *   - name: Client Responsiveness
 *     description: Client communication & responsiveness tracking
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { ClientResponsivenessController } from "./client-responsiveness.controller";

export class ClientResponsivenessRouter {
  public router: Router;
  public path: string;
  private clientResponsivenessController: ClientResponsivenessController;
  private validation: CommonValidation;

  constructor(
    clientResponsivenessController: ClientResponsivenessController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/client-responsiveness";
    this.clientResponsivenessController = clientResponsivenessController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    /**
     * @openapi
     * /client-responsiveness/stats:
     *   get:
     *     tags: [Client Responsiveness]
     *     summary: Get responsiveness statistics
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Responsiveness stats
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/ResponsivenessStats"
     */
    this.router.get("/stats", this.clientResponsivenessController.getStats);

    /**
     * @openapi
     * /client-responsiveness/:
     *   get:
     *     tags: [Client Responsiveness]
     *     summary: List all client responsiveness records
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: filter
     *         schema:
     *           type: string
     *           enum: [responsive, at_risk, unresponsive, critical]
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Client responsiveness list
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Pagination"
     */
    this.router.get(
      "/",
      this.clientResponsivenessController.getAllClientResponsiveness,
    );

    /**
     * @openapi
     * /client-responsiveness/{clientId}/requests:
     *   post:
     *     tags: [Client Responsiveness]
     *     summary: Add communication requests for a client
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: clientId
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/AddClientRequestsRequest"
     *     responses:
     *       201:
     *         description: Requests added
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/:clientId/requests",
      validateRequest({
        params: this.validation.params("clientId"),
        body: this.validation.requiredBody("caseId").merge(
          this.validation.requiredArrayBody("items"),
        ),
      }),
      this.clientResponsivenessController.addRequests,
    );

    /**
     * @openapi
     * /client-responsiveness/requests/{requestId}/fulfill:
     *   patch:
     *     tags: [Client Responsiveness]
     *     summary: Mark a client request as fulfilled
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: requestId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Request fulfilled
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Request not found }
     */
    this.router.patch(
      "/requests/:requestId/fulfill",
      validateRequest({ params: this.validation.params("requestId") }),
      this.clientResponsivenessController.fulfillRequest,
    );

    /**
     * @openapi
     * /client-responsiveness/{clientId}/termination-letter:
     *   post:
     *     tags: [Client Responsiveness]
     *     summary: Generate termination letter data for a client
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: clientId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Termination letter data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Client not found }
     */
    this.router.post(
      "/:clientId/termination-letter",
      validateRequest({ params: this.validation.params("clientId") }),
      this.clientResponsivenessController.generateTerminationLetter,
    );

    /**
     * @openapi
     * /client-responsiveness/{clientId}/export:
     *   get:
     *     tags: [Client Responsiveness]
     *     summary: Export client responsiveness report
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: clientId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Client report data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       404: { description: Client not found }
     */
    this.router.get(
      "/:clientId/export",
      validateRequest({ params: this.validation.params("clientId") }),
      this.clientResponsivenessController.exportReport,
    );
  }
}
