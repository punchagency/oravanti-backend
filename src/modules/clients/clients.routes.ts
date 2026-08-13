import { Router } from "express";
import multer from "multer";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { preserveRequestContext } from "../../middleware/request-context";
import { CommonValidation } from "../../validation/common.validation";

import { validateRequest } from "../../middleware/validate.middleware";
import { ClientsController } from "./clients.controller";

const updateClientProfileBody = z
  .object({
    firstName: z.string().trim().min(2, "First name is required").optional(),
    lastName: z.string().trim().min(2, "Last name is required").optional(),
    phone: z.string().trim().nullable().optional(),
  })
  .strict();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, GIF, and WebP images are allowed"));
    }
  },
});

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

    // Client profile (self-service)
    this.router.get("/profile", this.ctrl.getClientProfile);
    this.router.patch(
      "/profile",
      validateRequest({ body: updateClientProfileBody }),
      this.ctrl.updateClientProfile,
    );
    this.router.post(
      "/profile/avatar",
      preserveRequestContext(upload.single("avatar")),
      this.ctrl.uploadClientAvatar,
    );

    // Converted clients (must be before /:id routes)
    this.router.get("/converted", this.ctrl.listConvertedClients);
    this.router.get(
      "/converted/:clientId",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.getConvertedClientDetail,
    );

    // Portal management
    this.router.post(
      "/:clientId/invite",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.sendPortalInvitation,
    );
    this.router.post(
      "/:clientId/reset-password",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.resetClientPassword,
    );
    this.router.get(
      "/:clientId/sessions",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.getClientSessions,
    );
    this.router.delete(
      "/:clientId/sessions/:token",
      validateRequest({
        params: this.validation.params("clientId").extend({ token: this.validation.nonEmptyString }),
      }),
      this.ctrl.revokeClientSession,
    );
    this.router.get(
      "/:clientId/portal-status",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.getPortalStatus,
    );
    this.router.patch(
      "/:clientId/portal-status",
      validateRequest({ params: this.validation.params("clientId") }),
      this.ctrl.updatePortalStatus,
    );

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
