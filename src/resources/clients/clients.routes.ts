/**
 * @openapi
 * tags:
 *   - name: Clients
 *     description: Client & company management
 *
 * paths:
 *   /clients/certifications:
 *     get:
 *       tags: [Clients]
 *       summary: Get certifications grouped by level
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Certifications list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Certification"
 *
 *   /clients/teams/{teamId}/staff:
 *     get:
 *       tags: [Clients]
 *       summary: Get staff members in a team
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: teamId
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Team staff list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Staff"
 *
 *   /clients/:
 *     get:
 *       tags: [Clients]
 *       summary: List all clients (paginated)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: search
 *           schema: { type: string }
 *         - in: query
 *           name: page
 *           schema: { type: integer }
 *         - in: query
 *           name: limit
 *           schema: { type: integer }
 *         - in: query
 *           name: all
 *           schema: { type: boolean }
 *       responses:
 *         200:
 *           description: Paginated client list
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Pagination"
 *     post:
 *       tags: [Clients]
 *       summary: Create a new client (optionally with initial case)
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateClientRequest"
 *       responses:
 *         201:
 *           description: Client created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Client"
 *         409: { description: Duplicate client }
 *
 *   /clients/{id}:
 *     get:
 *       tags: [Clients]
 *       summary: Get client by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Client data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Client"
 *         404: { description: Client not found }
 *     patch:
 *       tags: [Clients]
 *       summary: Update a client
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateClientRequest"
 *       responses:
 *         200:
 *           description: Client updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Client"
 *         404: { description: Client not found }
 *     delete:
 *       tags: [Clients]
 *       summary: Delete a client
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Client deleted
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /clients/{id}/cases:
 *     get:
 *       tags: [Clients]
 *       summary: Get cases for a client
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *         - in: query
 *           name: page
 *           schema: { type: integer }
 *         - in: query
 *           name: limit
 *           schema: { type: integer }
 *       responses:
 *         200:
 *           description: Paginated case list
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Pagination"
 *     post:
 *       tags: [Clients]
 *       summary: Add a new case to a client
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [practiceAreaId, caseType]
 *               properties:
 *                 practiceAreaId: { type: string }
 *                 caseType: { type: string }
 *                 description: { type: string }
 *       responses:
 *         201:
 *           description: Case added
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Case"
 *
 *   /clients/{id}/cases/{caseId}/status:
 *     patch:
 *       tags: [Clients]
 *       summary: Update case status for a client's case
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *         - in: path
 *           name: caseId
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status]
 *               properties:
 *                 status: { type: string }
 *       responses:
 *         200:
 *           description: Case status updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Case"
 *
 *   /clients/companies:
 *     get:
 *       tags: [Clients]
 *       summary: List all companies
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Companies list
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/Company"
 *     post:
 *       tags: [Clients]
 *       summary: Create a company with optional client members
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateCompanyRequest"
 *       responses:
 *         201:
 *           description: Company created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Company"
 *
 *   /clients/companies/{id}:
 *     get:
 *       tags: [Clients]
 *       summary: Get company by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Company data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Company"
 *         404: { description: Company not found }
 *     patch:
 *       tags: [Clients]
 *       summary: Update a company
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateCompanyRequest"
 *       responses:
 *         200:
 *           description: Company updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Company"
 *         404: { description: Company not found }
 *     delete:
 *       tags: [Clients]
 *       summary: Delete a company
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Company deleted
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /clients/companies/{id}/clients:
 *     post:
 *       tags: [Clients]
 *       summary: Add a client to a company
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/AddClientToCompanyRequest"
 *       responses:
 *         201:
 *           description: Client added to company
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Client"
 */
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
