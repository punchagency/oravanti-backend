import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { StaffController } from "./staffs.controller";

export class StaffRouter {
  public router: Router;
  public path: string;
  private staffController: StaffController;
  private validation: CommonValidation;

  constructor(staffController: StaffController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/hr/staff";
    this.staffController = staffController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.staffController.getAll);
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.staffController.getById,
    );
    this.router.post(
      "/",
      validateRequest({
        body: this.validation.requiredBody(
          "firstName",
          "lastName",
          "email",
          "phone",
          "role",
          "teamId",
          "startDate",
        ),
      }),
      this.staffController.addStaff,
    );
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.staffController.updateStaff,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.staffController.deleteStaff,
    );
  }
}
