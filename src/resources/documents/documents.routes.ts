import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
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

    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.documentsController.getDocumentStats);
    this.router.get("/transfers", this.documentsController.getTransfers);
    this.router.get("/requests", this.documentsController.getExternalRequests);
    this.router.get("/", this.documentsController.getAllDocuments);

    this.router.post(
      "/",
      this.upload.single("file"),
      validateRequest({
        body: this.validation.requiredBody("caseId", "title"),
      }),
      this.documentsController.uploadDocument,
    );

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

    this.router.patch(
      "/requests/:requestId/cancel",
      validateRequest({
        params: z.object({ requestId: this.validation.uuid }),
      }),
      this.documentsController.cancelExternalRequest,
    );

    this.router.patch(
      "/transfers/:transferId/accept",
      validateRequest({
        params: z.object({ transferId: this.validation.uuid }),
      }),
      this.documentsController.acceptTransfer,
    );

    this.router.patch(
      "/transfers/:transferId/reject",
      validateRequest({
        params: z.object({ transferId: this.validation.uuid }),
      }),
      this.documentsController.rejectTransfer,
    );

    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getDocumentById,
    );

    this.router.get(
      "/:id/download",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getDownloadUrl,
    );

    this.router.get(
      "/:id/activity",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.getActivityLogs,
    );

    this.router.patch(
      "/:id",
      this.upload.single("file"),
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.updateDocument,
    );

    this.router.post(
      "/:id/versions",
      this.upload.single("file"),
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.updateDocument,
    );

    this.router.post(
      "/:id/cases",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("caseId"),
      }),
      this.documentsController.linkDocumentToCase,
    );

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

    this.router.post(
      "/:id/access/firms",
      validateRequest({
        params: this.validation.idParams,
        body: z.object({
          firmId: z.string().min(1, "firmId is required"),
          permission: documentPermission,
        }),
      }),
      this.documentsController.grantFirmAccess,
    );

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

    this.router.delete(
      "/:id/access/firms/:firmId",
      validateRequest({
        params: z.object({
          id: this.validation.uuid,
          firmId: z.string().min(1, "firmId is required"),
        }),
      }),
      this.documentsController.revokeFirmAccess,
    );

    this.router.post(
      "/:id/transfers",
      validateRequest({
        params: this.validation.idParams,
        body: z.object({
          toFirmId: z.string().min(1, "toFirmId is required"),
          toUserId: z.string().min(1).optional(),
          permission: documentPermission,
          message: z.string().optional(),
          revokeSenderAccess: z.boolean().optional(),
        }),
      }),
      this.documentsController.createTransfer,
    );

    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: z.object({ status: documentStatus }),
      }),
      this.documentsController.updateDocumentStatus,
    );

    this.router.patch(
      "/:id/archive",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.archiveDocument,
    );

    this.router.patch(
      "/:id/restore",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.restoreDocument,
    );

    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.deleteDocument,
    );
  }
}
