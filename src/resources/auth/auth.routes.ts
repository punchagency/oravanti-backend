/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Authentication & session management
 *   - name: Organization
 *     description: Organization invitations & membership
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { CommonValidation } from "../../validation/common.validation";
import { validateRequest } from "../../middleware/validate.middleware";
import { AuthController } from "./auth.controller";

const parseJsonField = (value: unknown) => {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseBooleanField = (value: unknown) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
};

const contractorSignUpBody = z
  .object({
    email: z.string().email("Must be a valid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    firstName: z.string().trim().min(1, "firstName is required"),
    lastName: z.string().trim().min(1, "lastName is required"),
    phoneNumber: z.string().trim().min(1, "phoneNumber is required"),
    desiredHourlyRate: z
      .union([z.string(), z.number()])
      .refine((value) => Number(value) > 0, {
        message: "desiredHourlyRate must be greater than zero",
      }),
    consentedToBackgroundCheck: z.preprocess(
      parseBooleanField,
      z.literal(true, {
        error: "Contractors must consent to a background check",
      }),
    ),
    recognizedDirectoryListingVerificationAccepted: z.preprocess(
      parseBooleanField,
      z.literal(true, {
        error:
          "Contractors must accept directory listing verification checks",
      }),
    ),
    bio: z.string().trim().min(1, "bio is required"),
    availability: z.enum(["full-time", "part-time", "project-based"]),
    specialtyIds: z.preprocess(
      parseJsonField,
      z
        .array(z.string().uuid("specialtyIds must contain valid UUIDs"))
        .min(1, "At least one specialty is required"),
    ),
    paymentDetails: z.preprocess(
      parseJsonField,
      z.discriminatedUnion("paymentMethod", [
        z.object({
          paymentMethod: z.literal("paypal"),
          paypalEmail: z.string().email("Must be a valid PayPal email"),
        }),
        z.object({
          paymentMethod: z.literal("bank_account"),
          accountHolderName: z
            .string()
            .trim()
            .min(1, "accountHolderName is required"),
          routingNumber: z.string().trim().min(1, "routingNumber is required"),
          accountNumber: z.string().trim().min(1, "accountNumber is required"),
        }),
      ]),
    ),
    certificationDocuments: z.preprocess(
      parseJsonField,
      z
        .array(
          z.object({
            certificationName: z
              .string()
              .trim()
              .min(1, "certificationName is required"),
            issuingOrganization: z.string().trim().optional(),
            issuedAt: z.string().optional(),
            expiresAt: z.string().optional(),
          }),
        )
        .min(1, "At least one certification document is required"),
    ),
    rememberMe: z.preprocess(parseBooleanField, z.boolean().optional()),
  })
  .strict();

export class AuthRouter {
  public router: Router;
  public path: string;
  private authController: AuthController;
  private validation: CommonValidation;
  private upload: multer.Multer;

  constructor(authController: AuthController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/auth";
    this.authController = authController;
    this.validation = validation;
    this.upload = multer({ storage: multer.memoryStorage() });

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    /**
     * @openapi
     * /auth/sign-up/email:
     *   post:
     *     tags: [Auth]
     *     summary: Register a new user with email & password
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/SignUpRequest"
     *     responses:
     *       200:
     *         description: User registered
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       409: { description: User already exists }
     */
    this.router.post(
      "/sign-up/email",
      validateRequest({ body: this.validation.requiredBody("email", "password") }),
      this.authController.signUpWithEmail,
    );

    /**
     * @openapi
     * /auth/contractors/sign-up/email:
     *   post:
     *     tags: [Auth]
     *     summary: Register a new contractor with email & password
     *     responses:
     *       200:
     *         description: Contractor registered
     *       400: { description: Invalid contractor signup data }
     *       409: { description: User already exists }
     */
    this.router.post(
      "/contractors/sign-up/email",
      this.upload.fields([
        { name: "certificationFiles" },
        { name: "identificationFiles", maxCount: 2 },
      ]),
      validateRequest({ body: contractorSignUpBody }),
      this.authController.signUpContractorWithEmail,
    );

    /**
     * @openapi
     * /auth/sign-in/email:
     *   post:
     *     tags: [Auth]
     *     summary: Sign in with email & password
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/SignInRequest"
     *     responses:
     *       200:
     *         description: Authenticated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/UserSessionResponse"
     *       401: { description: Invalid credentials }
     */
    this.router.post(
      "/sign-in/email",
      validateRequest({ body: this.validation.requiredBody("email", "password") }),
      this.authController.signInWithEmail,
    );

    /**
     * @openapi
     * /auth/two-factor/verify-totp:
     *   post:
     *     tags: [Auth]
     *     summary: Verify TOTP code during 2FA sign-in
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/VerifyTotpRequest"
     *     responses:
     *       200:
     *         description: TOTP verified
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/TotpVerifiedResponse"
     */
    this.router.post(
      "/two-factor/verify-totp",
      validateRequest({ body: this.validation.requiredBody("code") }),
      this.authController.verifyTOTP,
    );

    /**
     * @openapi
     * /auth/sign-out:
     *   post:
     *     tags: [Auth]
     *     summary: Sign out current session
     *     responses:
     *       200:
     *         description: Signed out
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post("/sign-out", this.authController.signOut);

    /**
     * @openapi
     * /auth/send-verification-otp:
     *   post:
     *     tags: [Auth]
     *     summary: Send email verification OTP
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/SendOtpRequest"
     *     responses:
     *       200:
     *         description: OTP sent
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/send-verification-otp",
      validateRequest({ body: this.validation.requiredBody("email", "type") }),
      this.authController.sendVerificationOTP,
    );

    /**
     * @openapi
     * /auth/reset-password:
     *   post:
     *     tags: [Auth]
     *     summary: Reset password using OTP
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/ResetPasswordRequest"
     *     responses:
     *       200:
     *         description: Password reset
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/reset-password",
      validateRequest({
        body: this.validation.requiredBody("email", "otp", "password"),
      }),
      this.authController.resetPasswordWithOTP,
    );

    /**
     * @openapi
     * /auth/change-password:
     *   post:
     *     tags: [Auth]
     *     summary: Change password (authenticated)
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/ChangePasswordRequest"
     *     responses:
     *       200:
     *         description: Password changed
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/change-password",
      validateRequest({
        body: this.validation.requiredBody("currentPassword", "newPassword"),
      }),
      this.authController.changePassword,
    );

    /**
     * @openapi
     * /auth/revoke-session:
     *   post:
     *     tags: [Auth]
     *     summary: Revoke a specific session
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/RevokeSessionRequest"
     *     responses:
     *       200:
     *         description: Session revoked
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/revoke-session",
      validateRequest({ body: this.validation.requiredBody("token") }),
      this.authController.revokeSession,
    );

    /**
     * @openapi
     * /auth/get-session:
     *   get:
     *     tags: [Auth]
     *     summary: Get current session info
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Session data
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/UserSessionResponse"
     */
    this.router.get("/get-session", this.authController.getSession);

    /**
     * @openapi
     * /auth/refresh-session:
     *   post:
     *     tags: [Auth]
     *     summary: Refresh current session
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Session refreshed
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/UserSessionResponse"
     */
    this.router.post("/refresh-session", this.authController.refreshSession);

    /**
     * @openapi
     * /auth/sessions:
     *   get:
     *     tags: [Auth]
     *     summary: List active sessions
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Active sessions list
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/SessionInfo"
     */
    this.router.get("/sessions", this.authController.getActiveSessions);

    /**
     * @openapi
     * /auth/two-factor/enable:
     *   post:
     *     tags: [Auth]
     *     summary: Enable 2FA for account
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/EnableTwoFactorRequest"
     *     responses:
     *       200:
     *         description: 2FA enabled
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/two-factor/enable",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.authController.enableTwoFactorAuth,
    );

    /**
     * @openapi
     * /auth/two-factor/disable:
     *   post:
     *     tags: [Auth]
     *     summary: Disable 2FA for account
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/EnableTwoFactorRequest"
     *     responses:
     *       200:
     *         description: 2FA disabled
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/two-factor/disable",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.authController.disableTwoFactorAuth,
    );
  }
}
