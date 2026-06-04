import { Router } from "express";
import { CommonValidation } from "../../validation/common.validation";
import { validateRequest } from "../../middleware/validate.middleware";
import { AuthController } from "./auth.controller";

export class AuthRouter {
  public router: Router;
  public path: string;
  private authController: AuthController;
  private validation: CommonValidation;

  constructor(authController: AuthController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/auth";
    this.authController = authController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.post(
      "/sign-up/email",
      validateRequest({ body: this.validation.requiredBody("email", "password") }),
      this.authController.signUpWithEmail,
    );
    this.router.post(
      "/sign-in/email",
      validateRequest({ body: this.validation.requiredBody("email", "password") }),
      this.authController.signInWithEmail,
    );
    this.router.post(
      "/two-factor/verify-totp",
      validateRequest({ body: this.validation.requiredBody("code") }),
      this.authController.verifyTOTP,
    );
    this.router.post("/sign-out", this.authController.signOut);
    this.router.post(
      "/send-verification-otp",
      validateRequest({ body: this.validation.requiredBody("email", "type") }),
      this.authController.sendVerificationOTP,
    );
    this.router.post(
      "/reset-password",
      validateRequest({
        body: this.validation.requiredBody("email", "otp", "password"),
      }),
      this.authController.resetPasswordWithOTP,
    );
    this.router.post(
      "/change-password",
      validateRequest({
        body: this.validation.requiredBody("currentPassword", "newPassword"),
      }),
      this.authController.changePassword,
    );
    this.router.post(
      "/revoke-session",
      validateRequest({ body: this.validation.requiredBody("token") }),
      this.authController.revokeSession,
    );
    this.router.get("/get-session", this.authController.getSession);
    this.router.post("/refresh-session", this.authController.refreshSession);
    this.router.get("/sessions", this.authController.getActiveSessions);
    this.router.post(
      "/two-factor/enable",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.authController.enableTwoFactorAuth,
    );
    this.router.post(
      "/two-factor/disable",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.authController.disableTwoFactorAuth,
    );
  }
}
