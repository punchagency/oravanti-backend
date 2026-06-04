/**
 * @openapi
 * tags:
 *   - name: Settings - Profile
 *     description: User profile management
 *
 * paths:
 *   /settings/profile/:
 *     get:
 *       tags: [Settings - Profile]
 *       summary: Get current user's profile
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: Profile data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Profile"
 *         404: { description: Profile not found }
 *     patch:
 *       tags: [Settings - Profile]
 *       summary: Update current user's profile
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateProfileRequest"
 *       responses:
 *         200:
 *           description: Profile updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/Profile"
 *
 *   /settings/profile/avatar:
 *     post:
 *       tags: [Settings - Profile]
 *       summary: Upload profile avatar
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           multipart/form-data:
 *             schema:
 *               type: object
 *               required: [avatar]
 *               properties:
 *                 avatar:
 *                   type: string
 *                   format: binary
 *       responses:
 *         200:
 *           description: Avatar uploaded
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
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
