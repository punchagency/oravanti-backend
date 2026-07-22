/**
 * @openapi
 * tags:
 *   - name: Documents
 *     description: Document resources, versions, user access, and external requests
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";

import { validateRequest } from "../../middleware/validate.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { DocumentsController } from "./documents.controller";

const documentPermission = z.enum(["VIEW", "COMMENT", "EDIT", "ADMIN"]);
const documentStatus = z.enum(["active", "archived", "deleted"]);

export class DocumentsRouter {
  public router: Router;
  public path: string;
  private documentsController: DocumentsController;
  private validation: CommonValidation;
  private upload: multer.Multer;

  constructor(
    documentsController: DocumentsController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/documents";
    this.documentsController = documentsController;
    this.validation = validation;
    this.upload = multer({ storage: multer.memoryStorage() });

    this.initializeRoutes();
  }

  private initializeRoutes() {
    /**
     * @openapi
     * /documents/requests/{token}/submissions:
     *   post:
     *     tags: [Documents]
     *     summary: Submit files for an external document request
     *     parameters:
     *       - in: path
     *         name: token
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         multipart/form-data:
     *           schema:
     *             type: object
     *             required: [uploadedByName, uploadedByEmail, file]
     *             properties:
     *               uploadedByName: { type: string }
     *               uploadedByEmail: { type: string, format: email }
     *               title: { type: string }
     *               file: { type: string, format: binary }
     *     responses:
     *       201:
     *         description: External submission uploaded
     *       404: { description: Document request not found }
     *       409: { description: Document request is not open or has expired }
     */
    this.router.post(
      "/requests/:token/submissions",
      this.upload.single("file"),
      validateRequest({
        params: this.validation.tokenParams("token"),
        body: this.validation.requiredBody(
          "uploadedByName",
          "uploadedByEmail",
        ),
      }),
      this.documentsController.submitExternalDocument,
    );

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /documents/stats:
     *   get:
     *     tags: [Documents]
     *     summary: Get document statistics by category
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Document stats
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     */
    this.router.get("/stats", this.documentsController.getDocumentStats);

    /**
     * @openapi
     * /documents/requests:
     *   get:
     *     tags: [Documents]
     *     summary: List external document requests
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: External document requests
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items: { type: object }
     */
    this.router.get("/requests", this.documentsController.getExternalRequests);

    /**
     * @openapi
     * /documents/:
     *   get:
     *     tags: [Documents]
     *     summary: List documents
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *       - in: query
     *         name: category
     *         schema: { type: string, enum: [application, supporting, identity, uscis_response] }
     *       - in: query
     *         name: caseId
     *         schema: { type: string, format: uuid }
     *       - in: query
     *         name: status
     *         schema: { type: string, enum: [active, archived, deleted] }
     *       - in: query
     *         name: page
     *         schema: { type: integer }
     *       - in: query
     *         name: limit
     *         schema: { type: integer }
     *     responses:
     *       200:
     *         description: Paginated document list
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Pagination"
     */
    this.router.get("/", this.documentsController.getAllDocuments);

    /**
     * @openapi
     * /documents/:
     *   post:
     *     tags: [Documents]
     *     summary: Upload a new document
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         multipart/form-data:
     *           schema:
     *             type: object
     *             required: [caseId, title, file]
     *             properties:
     *               caseId: { type: string, format: uuid }
     *               title: { type: string }
     *               category: { type: string, enum: [application, supporting, identity, uscis_response] }
     *               file: { type: string, format: binary }
     *     responses:
     *       201:
     *         description: Document uploaded
     */
    this.router.post(
      "/",
      this.upload.single("file"),
      validateRequest({
        body: this.validation.requiredBody("caseId", "title"),
      }),
      this.documentsController.uploadDocument,
    );

    /**
     * @openapi
     * /documents/requests:
     *   post:
     *     tags: [Documents]
     *     summary: Create an external document request
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [caseId, recipientEmail, expiresAt]
     *             properties:
     *               caseId: { type: string, format: uuid }
     *               recipientEmail: { type: string, format: email }
     *               recipientName: { type: string }
     *               message: { type: string }
     *               expiresAt: { type: string, format: date-time }
     *     responses:
     *       201:
     *         description: External document request created
     */
    this.router.post(
      "/requests",
      validateRequest({
        body: this.validation
          .requiredBody("caseId", "recipientEmail", "expiresAt")
          .extend({
            expiresAt: z.string().datetime("expiresAt must be a valid ISO date"),
          }),
      }),
      this.documentsController.createExternalRequest,
    );

    /**
     * @openapi
     * /documents/requests/{requestId}/cancel:
     *   patch:
     *     tags: [Documents]
     *     summary: Cancel an external document request
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: requestId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Request cancelled
     *       404: { description: Open document request not found }
     */
    this.router.patch(
      "/requests/:requestId/cancel",
      validateRequest({
        params: z.object({ requestId: this.validation.uuid }),
      }),
      this.documentsController.cancelExternalRequest,
    );

    /**
     * @openapi
     * /documents/{id}:
     *   get:
     *     tags: [Documents]
     *     summary: Get document by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Document data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Document"
     *       404: { description: Document not found }
     */
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getDocumentById,
    );

    /**
     * @openapi
     * /documents/{id}/download:
     *   get:
     *     tags: [Documents]
     *     summary: Create a signed download URL
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Signed download URL
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/SignedUrlResponse"
     */
    this.router.get(
      "/:id/download",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getDownloadUrl,
    );

    /**
     * @openapi
     * /documents/{id}/activity:
     *   get:
     *     tags: [Documents]
     *     summary: List document activity logs
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Document activity logs
     */
    this.router.get(
      "/:id/activity",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getActivityLogs,
    );

    /**
     * @openapi
     * /documents/{id}:
     *   patch:
     *     tags: [Documents]
     *     summary: Upload a new current version for a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         multipart/form-data:
     *           schema:
     *             type: object
     *             required: [file]
     *             properties:
     *               file: { type: string, format: binary }
     *     responses:
     *       201:
     *         description: Document version uploaded
     */
    this.router.patch(
      "/:id",
      this.upload.single("file"),
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.updateDocument,
    );

    /**
     * @openapi
     * /documents/{id}/versions:
     *   post:
     *     tags: [Documents]
     *     summary: Upload a new document version
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         multipart/form-data:
     *           schema:
     *             type: object
     *             required: [file]
     *             properties:
     *               file: { type: string, format: binary }
     *     responses:
     *       201:
     *         description: Document version uploaded
     */
    this.router.post(
      "/:id/versions",
      this.upload.single("file"),
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.updateDocument,
    );

    /**
     * @openapi
     * /documents/{id}/cases:
     *   post:
     *     tags: [Documents]
     *     summary: Link a document to a case
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [caseId]
     *             properties:
     *               caseId: { type: string, format: uuid }
     *     responses:
     *       201:
     *         description: Document linked to case
     */
    this.router.post(
      "/:id/cases",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("caseId"),
      }),
      this.documentsController.linkDocumentToCase,
    );

    /**
     * @openapi
     * /documents/{id}/access/users:
     *   post:
     *     tags: [Documents]
     *     summary: Grant document access to a user
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [userId, permission]
     *             properties:
     *               userId: { type: string }
     *               permission: { type: string, enum: [VIEW, COMMENT, EDIT, ADMIN] }
     *     responses:
     *       201:
     *         description: User access granted
     */
    this.router.post(
      "/:id/access/users",
      validateRequest({
        params: this.validation.idParams,
        body: z.object({
          userId: z.string().min(1, "userId is required"),
          permission: documentPermission,
        }),
      }),
      this.documentsController.grantUserAccess,
    );

    /**
     * @openapi
     * /documents/{id}/access/users/{userId}:
     *   delete:
     *     tags: [Documents]
     *     summary: Revoke user access to a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *       - in: path
     *         name: userId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: User access revoked
     */
    this.router.delete(
      "/:id/access/users/:userId",
      validateRequest({
        params: z.object({
          id: this.validation.uuid,
          userId: z.string().min(1, "userId is required"),
        }),
      }),
      this.documentsController.revokeUserAccess,
    );

    /**
     * @openapi
     * /documents/{id}/status:
     *   patch:
     *     tags: [Documents]
     *     summary: Update document status
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [status]
     *             properties:
     *               status: { type: string, enum: [active, archived, deleted] }
     *     responses:
     *       200:
     *         description: Document status updated
     */
    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: z.object({ status: documentStatus }),
      }),
      this.documentsController.updateDocumentStatus,
    );

    /**
     * @openapi
     * /documents/{id}/archive:
     *   patch:
     *     tags: [Documents]
     *     summary: Archive a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Document archived
     */
    this.router.patch(
      "/:id/archive",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.archiveDocument,
    );

    /**
     * @openapi
     * /documents/{id}/restore:
     *   patch:
     *     tags: [Documents]
     *     summary: Restore an archived or deleted document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Document restored
     */
    this.router.patch(
      "/:id/restore",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.restoreDocument,
    );

    /**
     * @openapi
     * /documents/{id}:
     *   delete:
     *     tags: [Documents]
     *     summary: Soft delete a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Document deleted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.deleteDocument,
    );
  }
}
