/**
 * @openapi
 * tags:
 *   - name: Settings - Security
 *     description: Security settings, 2FA & session management
 *
 * paths:
 *   /settings/security/change-password:
 *     post:
 *       tags: [Settings - Security]
 *       summary: Change account password
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
 *   /settings/security/2fa/status:
 *     get:
 *       tags: [Settings - Security]
 *       summary: Get 2FA enrollment status
 *       security: [{ bearerAuth: [] }]
 *       responses:
 *         200:
 *           description: 2FA status
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/TwoFactorStatus"
 *
 *   /settings/security/2fa/enroll:
 *     post:
 *       tags: [Settings - Security]
 *       summary: Enroll in two-factor authentication
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/EnableTwoFactorRequest"
 *       responses:
 *         200:
 *           description: 2FA enrolled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /settings/security/2fa/verify:
 *     post:
 *       tags: [Settings - Security]
 *       summary: Verify a 2FA TOTP code
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/VerifyTotpRequest"
 *       responses:
 *         200:
 *           description: Code verified
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /settings/security/2fa/unenroll:
 *     delete:
 *       tags: [Settings - Security]
 *       summary: Disable two-factor authentication
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [password]
 *               properties:
 *                 password: { type: string }
 *       responses:
 *         200:
 *           description: 2FA disabled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /settings/security/sessions:
 *     get:
 *       tags: [Settings - Security]
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
 *                   $ref: "#/components/schemas/Invitation"
 *
 *   /settings/security/sessions/{id}:
 *     delete:
 *       tags: [Settings - Security]
 *       summary: Delete (revoke) a session
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Session revoked
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { SecurityController } from "./security.controller";

export class SecurityRouter {
  public router: Router;
  public path: string;
  private securityController: SecurityController;
  private validation: CommonValidation;

  constructor(securityController: SecurityController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/settings/security";
    this.securityController = securityController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.post(
      "/change-password",
      validateRequest({
        body: this.validation.requiredBody("currentPassword", "newPassword"),
      }),
      this.securityController.changePassword,
    );
    this.router.get("/2fa/status", this.securityController.get2FAStatus);
    this.router.post(
      "/2fa/enroll",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.securityController.enroll2FA,
    );
    this.router.post(
      "/2fa/verify",
      validateRequest({ body: this.validation.requiredBody("code") }),
      this.securityController.verify2FA,
    );
    this.router.delete(
      "/2fa/unenroll",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.securityController.unenroll2FA,
    );
    this.router.get("/sessions", this.securityController.getSessions);
    this.router.delete(
      "/sessions/:id",
      validateRequest({ params: this.validation.tokenParams("id") }),
      this.securityController.deleteSession,
    );
  }
}
