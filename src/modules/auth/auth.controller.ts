import { Request, Response } from "express";
import { ContractorSignUpBody, SignInBody } from "../../types/auth.types";
import { applyAuthHeaders } from "../../utils/applyAuthHeaders";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { AuthService } from "./auth.service";

type ContractorSignUpFiles = {
  certificationFiles?: Express.Multer.File[];
  identificationFiles?: Express.Multer.File[];
};

export class AuthController {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  signUpWithEmail = asyncWrap(
    async (
      req: Request<
        {},
        {},
        { email: string; password: string; rememberMe?: boolean }
      >,
      res: Response,
    ) => {
      const authResponse = await this.authService.signUpWithEmail(
        req.body,
        req,
      );

      applyAuthHeaders(authResponse.headers, res);

      const data = await authResponse.json();
      sendSuccess(res, data, data.message ?? "Signup successful");
    },
  );

  signUpContractorWithEmail = asyncWrap(
    async (
      req: Request<{}, {}, ContractorSignUpBody>,
      res: Response,
    ) => {
      const files = req.files as ContractorSignUpFiles | undefined;
      const result = await this.authService.signUpContractorWithEmail(
        req.body,
        files?.certificationFiles ?? [],
        files?.identificationFiles ?? [],
        req,
      );

      applyAuthHeaders(result.headers, res);

      sendSuccess(res, { auth: result.authData, contractor: result.contractor }, "Contractor signup successful");
    },
  );

  signInWithEmail = asyncWrap(
    async (req: Request<{}, {}, SignInBody>, res: Response) => {
      const { email, password } = req.body;

      const authResponse = await this.authService.signInWithEmail(
        email,
        password,
        req,
      );

      applyAuthHeaders(authResponse.headers, res);

      const data = await authResponse.json();
      sendSuccess(res, data, "Sign in successful");
    },
  );

  verifyTOTP = asyncWrap(async (req: Request, res: Response) => {
    const { code } = req.body;

    const authResponse = await this.authService.verifyTOTP(code, req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();
    sendSuccess(res, data, "Sign in successful");
  });

  signOut = asyncWrap(async (req: Request, res: Response) => {
    const authResponse = await this.authService.signOut(req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();
    sendSuccess(res, null, data.message ?? "Sign out successful");
  });

  sendVerificationOTP = asyncWrap(
    async (
      req: Request<
        {},
        {},
        {
          email: string;
          type:
            | "sign-in"
            | "email-verification"
            | "forget-password"
            | "change-email";
        }
      >,
      res: Response,
    ) => {
      const { email, type } = req.body;

      const authResponse = await this.authService.sendVerificationOTP({ email, type });

      const data = await authResponse.json();
      sendSuccess(res, null, data.message ?? "OTP sent successfully");
    },
  );

  resetPasswordWithOTP = asyncWrap(async (req: Request, res: Response) => {
    const { email, otp, password } = req.body;

    const authResponse = await this.authService.resetPasswordWithOTP({ email, otp, password });

    const data = await authResponse.json();
    sendSuccess(res, null, data.message ?? "Password reset successful");
  });

  changePassword = asyncWrap(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    const authResponse = await this.authService.changePassword({ currentPassword, newPassword }, req);

    const data = await authResponse.json();
    sendSuccess(res, null, data.message ?? "Password updated successfully");
  });

  revokeSession = asyncWrap(async (req: Request, res: Response) => {
    const { token } = req.body;

    const authResponse = await this.authService.revokeSession(token, req);

    const data = await authResponse.json();
    sendSuccess(res, null, data.message ?? "Session revoked successfully");
  });

  getSession = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.getSession(req);

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    sendSuccess(res, data, data?.message ?? "Session retrieved successfully");
  });

  refreshSession = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.refreshSession(req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();
    sendSuccess(res, data, data.message ?? "Session refreshed successfully");
  });

  getActiveSessions = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.getActiveSessions(req);

    const data = await authResponse.json();
    sendSuccess(res, data, data.message ?? "Active sessions retrieved successfully");
  });

  enableTwoFactorAuth = asyncWrap(async (req, res) => {
    const { password } = req.body;

    const authResponse = await this.authService.enableTwoFactorAuth(password, req);

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    sendSuccess(res, data, data.message ?? "Two-factor authentication enabled successfully");
  });

  disableTwoFactorAuth = asyncWrap(async (req, res) => {
    const { password } = req.body;

    const authResponse = await this.authService.disableTwoFactorAuth(password, req);

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    sendSuccess(res, data, data.message ?? "Two-factor authentication disabled successfully");
  });

  verifyTwoFactorSetup = asyncWrap(async (req, res) => {
    const { token } = req.body;

    const authResponse = await this.authService.verifyTOTP(token, req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();
    sendSuccess(res, data, "Two-factor authentication verified");
  });

  verifyTwoFactorBackupCode = asyncWrap(async (req, res) => {
    const { code } = req.body;

    const authResponse = await this.authService.verifyTwoFactorBackupCode(
      { code },
      req,
    );

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();
    sendSuccess(res, data, data.message ?? "Backup code verified");
  });

  revokeSessionByToken = asyncWrap(async (req, res) => {
    const token = String(req.params.token);

    const authResponse = await this.authService.revokeSession(token, req);

    const data = await authResponse.json();
    sendSuccess(res, null, data.message ?? "Session revoked successfully");
  });
}