/**
 * @openapi
 * tags:
 *   - name: Email Account
 *     description: Email account connection & provider classification
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { injectUserDEK } from "../../middleware/injectUserDEK";
import { validateRequest } from "../../middleware/validate.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { EmailAccountController } from "./email-account.controller";

export class EmailAccountRouter {
  public router: Router;
  public path: string;
  private emailAccountController: EmailAccountController;
  private validation: CommonValidation;

  constructor(
    emailAccountController: EmailAccountController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/email-accounts";
    this.emailAccountController = emailAccountController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    /**
     * @openapi
     * /email-accounts/classify:
     *   post:
     *     tags: [Email Account]
     *     summary: Classify an email address provider
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               email:
     *                 type: string
     *     responses:
     *       200:
     *         description: Provider classified
     *       400:
     *         description: Invalid email
     */
    this.router.post(
      "/classify",
      requireAuth,
      validateRequest({ body: this.validation.requiredBody("email") }),
      this.emailAccountController.classify,
    );

    /**
     * @openapi
     * /email-accounts/connect-custom-auto:
     *   post:
     *     tags: [Email Account]
     *     summary: Auto-connect a custom email account
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               email:
     *                 type: string
     *               password:
     *                 type: string
     *     responses:
     *       200:
     *         description: Email account connected
     *       422:
     *         description: Auto-discovery failed
     */
    this.router.post(
      "/connect-custom-auto",
      requireAuth,
      injectUserDEK,
      validateRequest({
        body: this.validation.requiredBody("email", "password"),
      }),
      this.emailAccountController.connectCustomAuto,
    );

    /**
     * @openapi
     * /email-accounts/connect-custom-manual:
     *   post:
     *     tags: [Email Account]
     *     summary: Manually configure a custom email account
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               email:
     *                 type: string
     *               password:
     *                 type: string
     *               protocol:
     *                 type: string
     *                 enum: [imap, pop3]
     *                 default: imap
     *               imapHost:
     *                 type: string
     *               imapPort:
     *                 type: number
     *               pop3Host:
     *                 type: string
     *               pop3Port:
     *                 type: number
     *               smtpHost:
     *                 type: string
     *               smtpPort:
     *                 type: number
     *               secure:
     *                 type: boolean
     *                 default: true
     *     responses:
     *       200:
     *         description: Email account connected
     *       400:
     *         description: Verification failed
     */
    this.router.post(
      "/connect-custom-manual",
      requireAuth,
      injectUserDEK,
      validateRequest({
        body: this.validation.requiredBody(
          "email",
          "password",
          "smtpHost",
          "smtpPort",
        ),
      }),
      this.emailAccountController.connectCustomManual,
    );

    /**
     * @openapi
     * /email-accounts:
     *   get:
     *     tags: [Email Account]
     *     summary: List connected email accounts
     *     responses:
     *       200:
     *         description: List of connected email accounts
     */
    this.router.get("", requireAuth, this.emailAccountController.list);

    /**
     * @openapi
     * /email-accounts/{id}/enable:
     *   patch:
     *     tags: [Email Account]
     *     summary: Enable a connected email account
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Email account enabled
     *       404:
     *         description: Email account not found
     */
    this.router.patch(
      "/:id/enable",
      requireAuth,
      this.emailAccountController.enable,
    );

    /**
     * @openapi
     * /email-accounts/{id}/disable:
     *   patch:
     *     tags: [Email Account]
     *     summary: Disable a connected email account
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Email account disabled
     *       404:
     *         description: Email account not found
     */
    this.router.patch(
      "/:id/disable",
      requireAuth,
      this.emailAccountController.disable,
    );

    /**
     * @openapi
     * /email-accounts/{id}:
     *   delete:
     *     tags: [Email Account]
     *     summary: Permanently delete a connected email account
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Email account deleted
     *       404:
     *         description: Email account not found
     */
    this.router.delete("/:id", requireAuth, this.emailAccountController.remove);
  }
}
