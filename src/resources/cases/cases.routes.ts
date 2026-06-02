import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { CasesController } from "./cases.controller";

export class CasesRouter {
  public router: Router;
  public path: string;
  private casesController: CasesController;
  private validation: CommonValidation;

  constructor(casesController: CasesController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/cases";
    this.casesController = casesController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.get(
      "/generate-number",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({
        query: this.validation.query({
          practiceAreaId: this.validation.uuid,
          caseType: this.validation.nonEmptyString,
        }),
      }),
      this.casesController.generateCaseNumber,
    );
    this.router.get(
      "/",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.getAllCases,
    );
    this.router.get(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.idParams }),
      this.casesController.getCaseById,
    );
    this.router.post(
      "/",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "practiceAreaId",
          "caseType",
          "filingDate",
          "description",
        ),
      }),
      this.casesController.createCase,
    );
    this.router.patch(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.casesController.updateCase,
    );
    this.router.delete(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.idParams }),
      this.casesController.deleteCase,
    );
  }
}
