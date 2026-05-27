import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { ClientsController } from "./clients.controller";

export class ClientsRouter {
  public router: Router;
  public path: string;
  private clientsController: ClientsController;

  constructor(clientsController: ClientsController) {
    this.router = Router();
    this.path = "/clients";
    this.clientsController = clientsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/certifications",
      this.clientsController.getCertifications,
    );
    this.router.get(
      "/teams/:teamId/staff",
      this.clientsController.getTeamStaff,
    );

    // Individual clients
    this.router.get("/", this.clientsController.getAllClients);
    this.router.post("/", this.clientsController.createClient);
    this.router.get("/:id", this.clientsController.getClientById);
    this.router.patch("/:id", this.clientsController.updateClient);
    this.router.delete("/:id", this.clientsController.deleteClient);

    this.router.get("/:id/cases", this.clientsController.getClientCases);
    this.router.post("/:id/cases", this.clientsController.addCase);
    this.router.patch(
      "/:id/cases/:caseId/status",
      this.clientsController.updateCaseStatus,
    );

    // Companies
    this.router.get("/companies", this.clientsController.getAllCompanies);
    this.router.post(
      "/companies",
      this.clientsController.createCompanyWithClients,
    );
    this.router.get("/companies/:id", this.clientsController.getCompanyById);
    this.router.patch("/companies/:id", this.clientsController.updateCompany);
    this.router.delete("/companies/:id", this.clientsController.deleteCompany);
    this.router.post(
      "/companies/:id/clients",
      this.clientsController.addClientToCompany,
    );
  }
}
