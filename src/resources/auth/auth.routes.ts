/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Authentication & session management
 *   - name: Organization
 *     description: Organization invitations & membership
 *
 * paths:
 *   /auth/sign-up/email:
 *     post:
 *       tags: [Auth]
 *       summary: Register a new user with email & password
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/SignUpRequest"
 *       responses:
 *         200:
 *           description: User registered
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *         409: { description: User already exists }
 *
   *   /auth/sign-in/email:
   *     post:
   *       tags: [Auth]
   *       summary: Sign in with email & password
   *       requestBody:
   *         required: true
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/SignInRequest"
   *       responses:
   *         200:
   *           description: Authenticated
   *           content:
   *             application/json:
   *               schema:
   *                 $ref: "#/components/schemas/UserSessionResponse"
   *         401: { description: Invalid credentials }
 *
   *   /auth/two-factor/verify-totp:
   *     post:
   *       tags: [Auth]
   *       summary: Verify TOTP code during 2FA sign-in
   *       requestBody:
   *         required: true
   *         content:
   *           application/json:
   *             schema:
   *               $ref: "#/components/schemas/VerifyTotpRequest"
   *       responses:
   *         200:
   *           description: TOTP verified
   *           content:
   *             application/json:
   *               schema:
   *                 $ref: "#/components/schemas/TotpVerifiedResponse"
 *
 *   /auth/sign-out:
 *     post:
 *       tags: [Auth]
 *       summary: Sign out current session
 *       responses:
 *         200:
 *           description: Signed out
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /auth/send-verification-otp:
 *     post:
 *       tags: [Auth]
 *       summary: Send email verification OTP
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/SendOtpRequest"
 *       responses:
 *         200:
 *           description: OTP sent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /auth/reset-password:
 *     post:
 *       tags: [Auth]
 *       summary: Reset password using OTP
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/ResetPasswordRequest"
 *       responses:
 *         200:
 *           description: Password reset
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /auth/change-password:
 *     post:
 *       tags: [Auth]
 *       summary: Change password (authenticated)
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/ChangePasswordRequest"
 *       responses:
 *         200:
 *           description: Password changed
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /auth/revoke-session:
 *     post:
 *       tags: [Auth]
 *       summary: Revoke a specific session
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/RevokeSessionRequest"
 *       responses:
 *         200:
 *           description: Session revoked
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
   *   /auth/get-session:
   *     get:
   *       tags: [Auth]
   *       summary: Get current session info
   *       security: [{ bearerAuth: [] }]
   *       responses:
   *         200:
   *           description: Session data
   *           content:
   *             application/json:
   *               schema:
   *                 $ref: "#/components/schemas/UserSessionResponse"
   *
   *   /auth/refresh-session:
   *     post:
   *       tags: [Auth]
   *       summary: Refresh current session
   *       security: [{ bearerAuth: [] }]
   *       responses:
   *         200:
   *           description: Session refreshed
   *           content:
   *             application/json:
   *               schema:
   *                 $ref: "#/components/schemas/UserSessionResponse"
 *
 *   /auth/sessions:
 *     get:
 *       tags: [Auth]
 *       summary: List active sessions
 *       security: [{ bearerAuth: [] }]
   *       responses:
   *         200:
   *           description: Active sessions list
   *           content:
   *             application/json:
   *               schema:
   *                 type: array
   *                 items:
   *                   $ref: "#/components/schemas/SessionInfo"
 *
 *   /auth/two-factor/enable:
 *     post:
 *       tags: [Auth]
 *       summary: Enable 2FA for account
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/EnableTwoFactorRequest"
 *       responses:
 *         200:
 *           description: 2FA enabled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /auth/two-factor/disable:
 *     post:
 *       tags: [Auth]
 *       summary: Disable 2FA for account
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/EnableTwoFactorRequest"
 *       responses:
 *         200:
 *           description: 2FA disabled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
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
    this.router.post("/two-factor/verify-totp", this.authController.verifyTOTP);
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
