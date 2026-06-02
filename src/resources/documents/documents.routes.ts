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

    this.router.get("/stats", this.documentsController.getDocumentStats);
    this.router.get("/", this.documentsController.getAllDocuments);
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
    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.documentsController.updateDocumentStatus,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.documentsController.deleteDocument,
    );
  }
}
