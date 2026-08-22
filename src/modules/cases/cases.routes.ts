/**
 * @openapi
 * tags:
 *   - name: Cases
 *     description: Case management
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { requireResource } from "../../middleware/permission.middleware";


import { validateRequest } from "../../middleware/validate.middleware";
import { CasesController } from "./cases.controller";
import * as v from "./cases.validation";

export class CasesRouter {
  public router: Router;
  public path: string;
  private casesController: CasesController;

  constructor(casesController: CasesController) {
    this.router = Router();
    this.path = "/cases";
    this.casesController = casesController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    // Gate the whole router once. Every route below inherits it, so a new
    // endpoint cannot ship ungated by omission — and the per-route
    // `requireAuth`/`requirePermission` repetition disappears.
    this.router.use(requireAuth, resolveActorContext, requireResource("cases"));

    /**
     * @openapi
     * /cases/generate-number:
     *   get:
     *     tags: [Cases]
     *     summary: Generate a case number for a given practice area & type
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: practiceAreaId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: caseType
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Generated case number
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/CaseNumberResponse"
     */
    this.router.get(
      "/generate-number",
      validateRequest({ query: v.generateCaseNumberQuery }),
      this.casesController.generateCaseNumber,
    );

    /**
     * @openapi
     * /cases/:
     *   get:
     *     tags: [Cases]
     *     summary: List all cases (paginated, filterable)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *       - in: query
     *         name: status
     *         schema: { type: string }
     *       - in: query
     *         name: assigneeId
     *         schema: { type: string }
     *       - in: query
     *         name: clientId
     *         schema: { type: string }
     *       - in: query
     *         name: practiceAreaId
     *         schema: { type: string }
     *       - in: query
     *         name: page
     *         schema: { type: integer }
     *       - in: query
     *         name: limit
     *         schema: { type: integer }
     *     responses:
     *       200:
     *         description: Paginated list of cases
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Pagination"
     */
    this.router.get(
      "/",
      validateRequest({ query: v.listCasesQuery }),
      this.casesController.getAllCases,
    );

    /**
     * @openapi
     * /cases/{caseId}/documents:
     *   get:
     *     tags: [Cases]
     *     summary: Get documents linked to a case
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: page
     *         schema: { type: integer }
     *       - in: query
     *         name: limit
     *         schema: { type: integer }
     *     responses:
     *       200:
     *         description: Paginated list of case documents
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:caseId/documents",
      validateRequest({ params: v.caseDocumentsParams, query: v.paginationQuery }),
      this.casesController.getCaseDocuments,
    );

    /**
     * @openapi
     * /cases/{id}:
     *   get:
     *     tags: [Cases]
     *     summary: Get case by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Case data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Case"
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:id",
      validateRequest({ params: v.caseIdParams }),
      this.casesController.getCaseById,
    );

    /**
     * @openapi
     * /cases/:
     *   post:
     *     tags: [Cases]
     *     summary: Create a new case
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/CreateCaseRequest"
     *     responses:
     *       201:
     *         description: Case created
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Case"
     */
    this.router.post(
      "/",
      validateRequest({ body: v.createCaseBody }),
      this.casesController.createCase,
    );

    /**
     * @openapi
     * /cases/{id}:
     *   patch:
     *     tags: [Cases]
     *     summary: Update a case
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
     *             $ref: "#/components/schemas/UpdateCaseRequest"
     *     responses:
     *       200:
     *         description: Case updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Case"
     *       404: { description: Case not found }
     */
    this.router.patch(
      "/:id",
      validateRequest({ params: v.caseIdParams, body: v.updateCaseBody }),
      this.casesController.updateCase,
    );

    /**
     * @openapi
     * /cases/{id}:
     *   delete:
     *     tags: [Cases]
     *     summary: Delete a case
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Case deleted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.delete(
      "/:id",
      validateRequest({ params: v.caseIdParams }),
      this.casesController.deleteCase,
    );

    /**
     * @openapi
     * /cases/{id}/reassign-team:
     *   post:
     *     tags: [Cases]
     *     summary: Reassign a case to a different team
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
     *             type: object
     *             properties:
     *               teamId:
     *                 type: string
     *     responses:
     *       200:
     *         description: Team reassigned successfully
     *       404: { description: Case not found }
     */
    this.router.post(
      "/:id/reassign-team",
      validateRequest({ params: v.caseIdParams, body: v.reassignTeamBody }),
      this.casesController.reassignTeam,
    );

    this.router.get(
      "/:id/audit-log",
      validateRequest({ params: v.caseIdParams }),
      this.casesController.getCaseAuditLog,
    );
  }
}
