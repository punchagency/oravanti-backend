import { fromNodeHeaders } from "better-auth/node";
import { Request, Response } from "express";
import { auth } from "../../auth";
import { db } from "../../db/client";
import { connectedEmailAccount } from "../../db/schema/email";
import asyncWrap from "../../utils/asyncWrapper";
import { encryptData } from "../../utils/cryptoUtils";
import { BadRequestError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { EmailAccountService } from "./email-account.service";

export class EmailAccountController {
  private emailAccountService: EmailAccountService;

  constructor(emailAccountService: EmailAccountService) {
    this.emailAccountService = emailAccountService;
  }

  classify = asyncWrap(async (req: Request, res: Response) => {
    const { email } = req.body;
    const organizationId = (req as any).organizationId;

    if (!email || !email.includes("@")) {
      throw new BadRequestError("A valid email address is required.");
    }

    await this.emailAccountService.ensureEmailNotDuplicated(
      email,
      organizationId,
    );

    const provider = await this.emailAccountService.identifyProvider(email);

    sendSuccess(
      res,
      { email, provider },
      "Email provider classified successfully",
    );
  });

  connectCustomAuto = asyncWrap(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const userId = (req as any).userId;
    const organizationId = (req as any).organizationId;

    const discoveryResult =
      await this.emailAccountService.attemptCustomAutoDiscovery(
        email,
        password,
      );

    if (!discoveryResult.success || !discoveryResult.settings) {
      res.status(200).json({
        success: false,
        error: "Unable to auto-detect server settings.",
        fallbackToManualForm: true,
      });
      return;
    }

    const { settings } = discoveryResult;
    const encryptedPayload = encryptData(password, req.rawUserDEK!);

    const customSettings: any = {
      protocol: settings.protocol,
      smtpHost: settings.smtp,
      smtpPort: settings.smtpPort,
      encryptedPassword: encryptedPayload.ciphertext,
      iv: encryptedPayload.iv,
      tag: encryptedPayload.authTag,
    };

    if (settings.protocol === "imap") {
      customSettings.imapHost = settings.receiveHost;
      customSettings.imapPort = settings.receivePort;
    } else {
      customSettings.pop3Host = settings.receiveHost;
      customSettings.pop3Port = settings.receivePort;
    }

    await db.insert(connectedEmailAccount).values({
      userId,
      organizationId,
      email,
      provider: "custom",
      customSettings,
    });

    sendSuccess(
      res,
      null,
      "Custom email account verified and saved via auto-discovery.",
    );
  });

  connectCustomManual = asyncWrap(async (req: Request, res: Response) => {
    const {
      email,
      password,
      protocol,
      imapHost,
      imapPort,
      pop3Host,
      pop3Port,
      smtpHost,
      smtpPort,
      secure,
    } = req.body;
    const userId = (req as any).userId;
    const organizationId = (req as any).organizationId;

    try {
      await this.emailAccountService.verifyExplicitConfig({
        email,
        pass: password,
        protocol: protocol || "imap",
        imapHost: imapHost || undefined,
        imapPort: imapPort ? Number(imapPort) : undefined,
        pop3Host: pop3Host || undefined,
        pop3Port: pop3Port ? Number(pop3Port) : undefined,
        smtpHost,
        smtpPort: Number(smtpPort),
        secure: Boolean(secure),
      });
    } catch (error: any) {
      throw new BadRequestError(
        `Manual configuration verification failed: ${error.message}`,
      );
    }

    const encryptedPayload = encryptData(password, req.rawUserDEK!);

    const resolvedProtocol = protocol === "pop3" ? "pop3" : "imap";

    await db.insert(connectedEmailAccount).values({
      userId,
      organizationId,
      email,
      provider: "custom",
      customSettings: {
        protocol: resolvedProtocol,
        smtpHost,
        smtpPort: Number(smtpPort),
        ...(resolvedProtocol === "imap"
          ? { imapHost, imapPort: Number(imapPort) }
          : { pop3Host, pop3Port: Number(pop3Port) }),
        encryptedPassword: encryptedPayload.ciphertext,
        iv: encryptedPayload.iv,
        tag: encryptedPayload.authTag,
      },
    });

    sendSuccess(
      res,
      null,
      "Custom server verified and manually mapped successfully.",
    );
  });

  list = asyncWrap(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const organizationId = (req as any).organizationId;
    const status = req.query.status as string | undefined;

    const validStatus =
      status === "active" || status === "disabled" ? status : undefined;

    const emailAccounts = await this.emailAccountService.listEmailAccounts(
      userId,
      organizationId,
      validStatus,
    );

    sendSuccess(
      res,
      emailAccounts,
      "Connected email accounts retrieved successfully.",
    );
  });

  enable = asyncWrap(async (req: Request, res: Response) => {
    const { id } = req.params;
    const organizationId = (req as any).organizationId;

    await this.emailAccountService.enableEmailAccount(
      String(id),
      organizationId,
    );

    sendSuccess(res, null, "Email account enabled successfully.");
  });

  disable = asyncWrap(async (req: Request, res: Response) => {
    const { id } = req.params;
    const organizationId = (req as any).organizationId;

    await this.emailAccountService.disableEmailAccount(
      String(id),
      organizationId,
    );

    sendSuccess(res, null, "Email account disabled successfully.");
  });

  remove = asyncWrap(async (req: Request, res: Response) => {
    const { id } = req.params;
    const organizationId = (req as any).organizationId;

    // Find the account before deleting so we can unlink the social connection
    const account = await this.emailAccountService.findEmailAccount(
      String(id),
      organizationId,
    );

    if (account && account.provider !== "custom" && account.providerAccountId) {
      try {
        await auth.api.unlinkAccount({
          body: {
            providerId: account.provider,
            accountId: account.providerAccountId,
          },
          headers: fromNodeHeaders(req.headers),
        });
      } catch (e) {
        console.error("Failed to unlink Better Auth social account:", e);
        // Continue with deletion even if unlink fails
      }
    }

    await this.emailAccountService.deleteEmailAccount(
      String(id),
      organizationId,
    );

    sendSuccess(res, null, "Email account deleted permanently.");
  });

  private buildOAuthRedirect = async (
    req: Request,
    provider: "google" | "microsoft",
  ) => {
    const frontendUrl = this.emailAccountService.getFrontendUrl();
    const callbackURL = new URL("/settings/email-accounts", frontendUrl);
    callbackURL.searchParams.set("oauth", "success");

    const errorURL = new URL("/settings/email-accounts", frontendUrl);
    errorURL.searchParams.set("oauth", "error");

    const { url } = await auth.api.linkSocialAccount({
      body: {
        provider,
        callbackURL: callbackURL.toString(),
        errorCallbackURL: errorURL.toString(),
      },
      headers: fromNodeHeaders(req.headers),
    });

    return url;
  };

  initiateGoogleOAuth = asyncWrap(async (req: Request, res: Response) => {
    const url = await this.buildOAuthRedirect(req, "google");
    res.redirect(url);
  });

  initiateMicrosoftOAuth = asyncWrap(async (req: Request, res: Response) => {
    const url = await this.buildOAuthRedirect(req, "microsoft");
    res.redirect(url);
  });
}
