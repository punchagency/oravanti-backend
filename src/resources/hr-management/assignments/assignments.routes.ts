import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { AssignmentsController } from "./assignments.controller";

export class AssignmentsRouter {
  public router: Router;
  public path: string;
  private assignmentsController: AssignmentsController;
  private validation: CommonValidation;

  constructor(
    assignmentsController: AssignmentsController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/hr/assignments";
    this.assignmentsController = assignmentsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/available-contractors",
      validateRequest({
        query: this.validation.query({
          filingType: this.validation.enumValue([
            "I-130",
            "I-485",
            "I-765",
            "I-140",
            "N-400",
            "I-131",
          ]),
        }),
      }),
      this.assignmentsController.getAvailableContractors,
    );
    this.router.get("/", this.assignmentsController.getAllAssignments);
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.assignmentsController.getAssignmentById,
    );
    this.router.post(
      "/",
      validateRequest({
        body: this.validation
          .requiredBody("assignmentType", "urgencyLevel")
          .extend({
            filingType: this.validation.enumValue([
              "I-130",
              "I-485",
              "I-765",
              "I-140",
              "N-400",
              "I-131",
            ]),
          }),
      }),
      this.assignmentsController.assignCase,
    );
    this.router.patch(
      "/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.assignmentsController.updateAssignmentStatus,
    );
  }
}
