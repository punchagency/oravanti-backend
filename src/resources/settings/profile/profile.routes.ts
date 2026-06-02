import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { validateRequest } from "../../../middleware/validate.middleware";
import { ProfileController } from "./profile.controller";

export class ProfileRouter {
  public router: Router;
  public path: string;
  private profileController: ProfileController;
  private validation: CommonValidation;
  private upload: multer.Multer;

  constructor(profileController: ProfileController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/settings/profile";
    this.profileController = profileController;
    this.validation = validation;
    this.upload = multer({ storage: multer.memoryStorage() });

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);

    this.router.get("/", this.profileController.getProfile);
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.optionalBody() }),
      this.profileController.updateProfile,
    );
    this.router.post(
      "/avatar",
      this.upload.single("avatar"),
      this.profileController.uploadAvatar,
    );
  }
}
