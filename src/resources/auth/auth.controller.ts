import { Request, Response } from "express";
import { SignInBody } from "../../types/auth.types";
import { applyAuthHeaders } from "../../utils/applyAuthHeaders";
import asyncWrap from "../../utils/asyncWrapper";
import { AuthService } from "./auth.service";

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
      const { email, password, rememberMe = false } = req.body;

      const authResponse = await this.authService.signUpWithEmail(
        req.body,
        req,
      );

      applyAuthHeaders(authResponse.headers, res);

      const data = await authResponse.json();

      res.status(200).json({
        message: data.message ?? "Signup successful",
        success: true,
        data,
      });
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

      res.status(200).json({
        message: "Sign in successful",
        success: true,
        data,
      });
    },
  );

  verifyTOTP = asyncWrap(async (req: Request, res: Response) => {
    const { code } = req.body;

    const authResponse = await this.authService.verifyTOTP(code, req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();

    res.status(200).json({
      message: "Sign in successful",
      success: true,

      data,
    });
  });

  signOut = asyncWrap(async (req: Request, res: Response) => {
    const authResponse = await this.authService.signOut(req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Sign out successful",
      success: true,
    });
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

      const authResponse = await this.authService.sendVerificationOTP({
        email,
        type,
      });

      const data = await authResponse.json();

      res.status(200).json({
        message: data.message ?? "OTP sent successfully",
        success: true,
      });
    },
  );

  resetPasswordWithOTP = asyncWrap(async (req: Request, res: Response) => {
    const { email, otp, password } = req.body;

    const authResponse = await this.authService.resetPasswordWithOTP({
      email,
      otp,
      password,
    });

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Password reset successful",
      success: true,
    });
  });

  changePassword = asyncWrap(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    const authResponse = await this.authService.changePassword(
      {
        currentPassword,
        newPassword,
      },
      req,
    );

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Password updated successfully",
      success: true,
    });
  });

  revokeSession = asyncWrap(async (req: Request, res: Response) => {
    const { token } = req.body;

    const authResponse = await this.authService.revokeSession(token, req);

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Session revoked successfully",
      success: true,
    });
  });

  getSession = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.getSession(req);

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    res.status(200).json({
      message: data.message ?? "Session retrieved successfully",
      success: true,
      data,
    });
  });

  refreshSession = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.refreshSession(req);

    applyAuthHeaders(authResponse.headers, res);

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Session refreshed successfully",
      success: true,
      data,
    });
  });

  getActiveSessions = asyncWrap(async (req, res) => {
    const authResponse = await this.authService.getActiveSessions(req);

    const data = await authResponse.json();

    res.status(200).json({
      message: data.message ?? "Active sessions retrieved successfully",
      success: true,
      data,
    });
  });

  enableTwoFactorAuth = asyncWrap(async (req, res) => {
    const { password } = req.body;

    const authResponse = await this.authService.enableTwoFactorAuth(
      password,
      req,
    );

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    res.status(200).json({
      message: data.message ?? "Two-factor authentication enabled successfully",
      success: true,
      data,
    });
  });

  disableTwoFactorAuth = asyncWrap(async (req, res) => {
    const { password } = req.body;

    const authResponse = await this.authService.disableTwoFactorAuth(
      password,
      req,
    );

    const data = await authResponse.json();

    applyAuthHeaders(authResponse.headers, res);

    res.status(200).json({
      message:
        data.message ?? "Two-factor authentication disabled successfully",
      success: true,
      data,
    });
  });
}
