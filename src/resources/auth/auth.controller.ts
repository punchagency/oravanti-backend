import { Request, Response } from "express";
import {
  ForgotPasswordBody,
  SignInBody,
  SignUpBody,
} from "../../types/auth.types";
import { logSession } from "../settings/security/security.service";
import {
  sendPasswordResetEmail,
  signInAdmin,
  signUpAdmin,
} from "./auth.service";
import { BadRequestError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";

export const signUp = async (
  req: Request<{}, {}, SignUpBody>,
  res: Response,
) => {
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

  try {
    const data = await signUpAdmin(req.body);
    res.status(201).json({
      message: "Account created successfully",
      session: data.session,
      user: data.user,
      firm: data.firm,
    });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const signIn = async (
  req: Request<{}, {}, SignInBody>,
  res: Response,
) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new BadRequestError("Email and password are required");
  }

  try {
    const data = await signInAdmin(email, password);

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
    sendErrorResponse(res, error, 401);
  }
};

export const forgotPassword = async (
  req: Request<{}, {}, ForgotPasswordBody>,
  res: Response,
) => {
  const { email } = req.body;

  if (!email) {
    throw new BadRequestError("Email is required");
  }

  try {
    await sendPasswordResetEmail(email);
    res.status(200).json({ message: "Password reset email sent" });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};
