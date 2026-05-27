import { Request, Response } from "express";
import {
  ForgotPasswordBody,
  SignInBody,
  SignUpBody,
} from "../../types/auth.types";
import { logSession } from "../settings/security/security.service";
import { AuthService } from "./auth.service";

export class AuthController {
  private authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  signUp = async (req: Request<{}, {}, SignUpBody>, res: Response) => {
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
      res.status(400).json({
        message:
          "firstName, lastName, email, password, firmName, and firmEmail are required",
      });
      return;
    }

    try {
      const data = await this.authService.signUpAdmin(req.body);
      res.status(201).json({
        message: "Account created successfully",
        session: data.session,
        user: data.user,
        firm: data.firm,
      });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  signIn = async (req: Request<{}, {}, SignInBody>, res: Response) => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    try {
      const data = await this.authService.signInAdmin(email, password);

      const userId = data.user?.id;
      if (userId) {
        const userAgent = (req.headers["user-agent"] as string) ?? "Unknown";
        const ipAddress = req.ip ?? req.socket.remoteAddress ?? "Unknown";
        logSession(userId, userAgent, ipAddress).catch(() => {});
      }

      res.status(200).json({
        message: "Sign in successful",
        session: data.session,
        user: data.user,
      });
    } catch (error) {
      res.status(401).json({ message: (error as Error).message });
    }
  };

  forgotPassword = async (
    req: Request<{}, {}, ForgotPasswordBody>,
    res: Response,
  ) => {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: "Email is required" });
      return;
    }

    try {
      await this.authService.sendPasswordResetEmail(email);
      res.status(200).json({ message: "Password reset email sent" });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };
}
