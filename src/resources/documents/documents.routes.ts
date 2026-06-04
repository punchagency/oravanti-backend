/**
 * @openapi
 * tags:
 *   - name: Documents
 *     description: Document management & file uploads
 */
import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { DocumentsController } from "./documents.controller";

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
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

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
     *               $ref: "#/components/schemas/TaskStats"
     */
    this.router.get("/stats", this.documentsController.getDocumentStats);

    /**
     * @openapi
     * /documents/:
     *   get:
     *     tags: [Documents]
     *     summary: List documents (paginated, filterable)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *       - in: query
     *         name: category
     *         schema: { type: string }
     *       - in: query
     *         name: clientId
     *         schema: { type: string }
     *       - in: query
     *         name: caseId
     *         schema: { type: string }
     *       - in: query
     *         name: status
     *         schema: { type: string }
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
     * /documents/{id}:
     *   get:
     *     tags: [Documents]
     *     summary: Get document metadata by ID
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
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
     *     summary: Get a signed download URL for a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
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
     * /documents/:
     *   post:
     *     tags: [Documents]
     *     summary: Upload a document
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         multipart/form-data:
     *           schema:
     *             type: object
     *             required: [file, clientId, caseId, name, category]
     *             properties:
     *               file:
     *                 type: string
     *                 format: binary
     *               clientId: { type: string }
     *               caseId: { type: string }
     *               name: { type: string }
     *               category: { type: string }
     *     responses:
     *       201:
     *         description: Document uploaded
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Document"
     */
    this.router.post(
      "/",
      this.upload.single("file"),
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "caseId",
          "name",
          "category",
        ),
      }),
      this.documentsController.uploadDocument,
    );

    /**
     * @openapi
     * /documents/{id}/status:
     *   patch:
     *     tags: [Documents]
     *     summary: Update document review status
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
     *             $ref: "#/components/schemas/UpdateDocumentStatusRequest"
     *     responses:
     *       200:
     *         description: Document status updated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/Document"
     *       404: { description: Document not found }
     */
    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.documentsController.updateDocumentStatus,
    );

    /**
     * @openapi
     * /documents/{id}:
     *   delete:
     *     tags: [Documents]
     *     summary: Delete a document
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
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
