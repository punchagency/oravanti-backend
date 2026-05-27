import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { DocumentsController } from "./documents.controller";

export class DocumentsRouter {
  public router: Router;
  public path: string;
  private documentsController: DocumentsController;
  private upload: multer.Multer;

  constructor(documentsController: DocumentsController) {
    this.router = Router();
    this.path = "/documents";
    this.documentsController = documentsController;
    this.upload = multer({ storage: multer.memoryStorage() });

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.documentsController.getDocumentStats);
    this.router.get("/", this.documentsController.getAllDocuments);
    this.router.get("/:id", this.documentsController.getDocumentById);
    this.router.get("/:id/download", this.documentsController.getDownloadUrl);
    this.router.post(
      "/",
      this.upload.single("file"),
      this.documentsController.uploadDocument,
    );
    this.router.patch(
      "/:id/status",
      this.documentsController.updateDocumentStatus,
    );
    this.router.delete("/:id", this.documentsController.deleteDocument);
  }
}
