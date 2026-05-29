import { Router } from "express";
import { AuthController } from "./auth.controller";

export class AuthRouter {
  public router: Router;
  public path: string;
  private authController: AuthController;

  constructor(authController: AuthController) {
    this.router = Router();
    this.path = "/auth";
    this.authController = authController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.post("/sign-up/email", this.authController.signUpWithEmail);
    this.router.post("/sign-in/email", this.authController.signInWithEmail);
    this.router.post("/verify-totp", this.authController.verifyTOTP);
    this.router.post("/sign-out", this.authController.signOut);
    this.router.post(
      "/send-verification-otp",
      this.authController.sendVerificationOTP,
    );
    this.router.post(
      "/reset-password",
      this.authController.resetPasswordWithOTP,
    );
    this.router.post("/change-password", this.authController.changePassword);
    this.router.post("/revoke-session", this.authController.revokeSession);
    this.router.get("/get-session", this.authController.getSession);
    this.router.post("/refresh-session", this.authController.refreshSession);
    this.router.get("/sessions", this.authController.getActiveSessions);
    this.router.post(
      "/two-factor/enable",
      this.authController.enableTwoFactorAuth,
    );
    this.router.post(
      "/two-factor/disable",
      this.authController.disableTwoFactorAuth,
    );
  }
}
