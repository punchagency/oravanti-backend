import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { ClientsController } from "./clients.controller";

export class ClientsRouter {
  public router: Router;
  public path: string;
  private clientsController: ClientsController;
  private validation: CommonValidation;

  constructor(clientsController: ClientsController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/clients";
    this.clientsController = clientsController;
    this.validation = validation;

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

    // Companies
    this.router.get("/companies", this.clientsController.getAllCompanies);
    this.router.post(
      "/companies",
      validateRequest({
        body: this.validation.requiredBody("company", "individuals"),
      }),
      this.clientsController.createCompanyWithClients,
    );
    this.router.get(
      "/companies/:id",
      validateRequest({ params: this.validation.idParams }),
      this.clientsController.getCompanyById,
    );
    this.router.patch(
      "/companies/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.clientsController.updateCompany,
    );
    this.router.delete(
      "/companies/:id",
      validateRequest({ params: this.validation.idParams }),
      this.clientsController.deleteCompany,
    );
    this.router.post(
      "/companies/:id/clients",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("clientData", "caseData"),
      }),
      this.clientsController.addClientToCompany,
    );

    // Individual clients
    this.router.get("/", this.clientsController.getAllClients);
    this.router.post(
      "/",
      validateRequest({ body: this.validation.requiredBody("client", "case") }),
      this.clientsController.createClient,
    );
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.clientsController.getClientById,
    );
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.clientsController.updateClient,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.clientsController.deleteClient,
    );

    this.router.get(
      "/:id/cases",
      validateRequest({ params: this.validation.idParams }),
      this.clientsController.getClientCases,
    );
    this.router.post(
      "/:id/cases",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.clientsController.addCase,
    );
    this.router.patch(
      "/:id/cases/:caseId/status",
      validateRequest({
        params: this.validation.params("id", "caseId"),
        body: this.validation.requiredBody("status"),
      }),
      this.clientsController.updateCaseStatus,
    );
  }
}
