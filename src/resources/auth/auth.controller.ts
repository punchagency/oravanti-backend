import { Request, Response } from "express";
import {
  ForgotPasswordBody,
  SignInBody,
  SignUpBody,
} from "../../types/auth.types";
import { SecurityService } from "../settings/security/security.service";
import { AuthService } from "./auth.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError } from "../../utils/error/app-error";

export class AuthController {
  private authService: AuthService;
  private securityService = new SecurityService();

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  signUp = asyncWrap(
    async (req: Request<{}, {}, SignUpBody>, res: Response) => {
      const { firstName, lastName, email, password, firmName, firmEmail } =
        req.body;

      if (
        !firstName ||
        !lastName ||
        !email ||
        !password ||
        !firmName ||
        !firmEmail
      ) {
        throw new BadRequestError(
          "firstName, lastName, email, password, firmName, and firmEmail are required",
        );
      }

      const data = await this.authService.signUpAdmin(req.body);
      res.status(201).json({
        message: "Account created successfully",
        session: data.session,
        user: data.user,
        firm: data.firm,
      });
    },
  );

  signIn = asyncWrap(
    async (req: Request<{}, {}, SignInBody>, res: Response) => {
      const { email, password } = req.body;

      if (!email || !password) {
        throw new BadRequestError("Email and password are required");
      }

      const data = await this.authService.signInAdmin(email, password);

      const userId = data.user?.id;
      if (userId) {
        const userAgent = (req.headers["user-agent"] as string) ?? "Unknown";
        const ipAddress = req.ip ?? req.socket.remoteAddress ?? "Unknown";
        this.securityService
          .logSession(userId, userAgent, ipAddress)
          .catch(() => {});
      }

      res.status(200).json({
        message: "Sign in successful",
        session: data.session,
        user: data.user,
      });
    },
  );

  forgotPassword = asyncWrap(
    async (req: Request<{}, {}, ForgotPasswordBody>, res: Response) => {
      const { email } = req.body;

      if (!email) {
        throw new BadRequestError("Email is required");
      }

      await this.authService.sendPasswordResetEmail(email);
      res.status(200).json({ message: "Password reset email sent" });
    },
  );
}
