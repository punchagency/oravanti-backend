import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { CommonValidation } from "../../validation/common.validation";

import { validateRequest } from "../../middleware/validate.middleware";
import { ClientsController } from "./clients.controller";

export class ClientsRouter {
  public router: Router;
  public path: string;
  private ctrl: ClientsController;
  private validation: CommonValidation;

  constructor(clientsController: ClientsController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/clients";
    this.ctrl = clientsController;
    this.validation = validation;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Utilities
    this.router.get("/certifications", this.ctrl.getCertifications);
    this.router.get("/teams/:teamId/staff", this.ctrl.getTeamStaff);

    // Clients
    this.router.get("/", this.ctrl.getAllClients);
    this.router.get("/:id", validateRequest({ params: this.validation.idParams }), this.ctrl.getClientById);
    this.router.patch(
      "/:id",
      validateRequest({ params: this.validation.idParams, body: this.validation.optionalBody() }),
      this.ctrl.updateClient,
    );
    this.router.delete("/:id", validateRequest({ params: this.validation.idParams }), this.ctrl.deleteClient);

    // Contacts
    this.router.get("/:id/contacts", validateRequest({ params: this.validation.idParams }), this.ctrl.getClientContacts);
    this.router.post(
      "/:id/contacts",
      validateRequest({ params: this.validation.idParams, body: this.validation.requiredBody("firstName", "lastName", "email", "role") }),
      this.ctrl.addClientContact,
    );
    this.router.patch(
      "/:id/contacts/:contactId",
      validateRequest({ params: this.validation.params("id", "contactId"), body: this.validation.optionalBody() }),
      this.ctrl.updateClientContact,
    );
    this.router.delete(
      "/:id/contacts/:contactId",
      validateRequest({ params: this.validation.params("id", "contactId") }),
      this.ctrl.deleteClientContact,
    );

    // Company (for entityType=company clients)
    this.router.get("/:id/company", validateRequest({ params: this.validation.idParams }), this.ctrl.getClientCompany);
    this.router.patch(
      "/:id/company",
      validateRequest({ params: this.validation.idParams, body: this.validation.optionalBody() }),
      this.ctrl.upsertClientCompany,
    );

    // Cases
    this.router.get("/:id/cases", validateRequest({ params: this.validation.idParams }), this.ctrl.getClientCases);
  }
}
