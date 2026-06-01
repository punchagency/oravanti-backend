import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { Request } from "express";
import { auth } from "../../../auth";
import { db } from "../../../db/client";
import { user } from "../../../db/schema/auth-schema";
import {
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from "../../../utils/error/app-error";

type AuthServiceError = {
  message: string;
  status?: number;
};

const mapAuthError = (error: AuthServiceError) => {
  switch (error.status) {
    case 400:
      return new BadRequestError(error.message);
    case 401:
      return new AuthenticationError(error.message);
    case 403:
      return new AuthorizationError(error.message);
    case 404:
      return new NotFoundError(error.message);
    case 422:
      return new ValidationError(error.message);
    default:
      return new ExternalServiceError(error.message);
  }
};

export class SecurityService {
  // ─── Change Password ─────────────────────────────────────────────────────────

  changePassword = async (
    req: Request,
    currentPassword: string,
    newPassword: string,
  ) => {
    await auth.api.changePassword({
      headers: fromNodeHeaders(req.headers),
      body: { currentPassword, newPassword, revokeOtherSessions: true },
    });
  };

  // ─── Two-Factor Authentication ───────────────────────────────────────────────

  get2FAStatus = async (userId: string) => {
    const [authUser] = await db
      .select({ twoFactorEnabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!authUser) throw new NotFoundError("User not found");

    return { enabled: !!authUser.twoFactorEnabled };
  };

  enroll2FA = async (req: Request, password: string) => {
    return auth.api.enableTwoFactor({
      headers: fromNodeHeaders(req.headers),
      body: { password, issuer: "Oravanti" },
    });
  };

  verify2FA = async (req: Request, code: string) => {
    await auth.api.verifyTOTP({
      headers: fromNodeHeaders(req.headers),
      body: { code },
    });
  };

  unenroll2FA = async (req: Request, password: string) => {
    await auth.api.disableTwoFactor({
      headers: fromNodeHeaders(req.headers),
      body: { password },
    });
  };

  // ─── Active Sessions ─────────────────────────────────────────────────────────

  getSessions = async (req: Request) => {
    return auth.api.listSessions({
      headers: fromNodeHeaders(req.headers),
    });
  };

  deleteSession = async (req: Request, token: string) => {
    await auth.api.revokeSession({
      headers: fromNodeHeaders(req.headers),
      body: { token },
    });
  };
}
