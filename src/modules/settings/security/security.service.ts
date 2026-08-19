import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { Request } from "express";
import { auth } from "../../../auth";
import { db } from "../../../db/client";
import { user } from "../../../db/schema/auth-schema";
import {
  NotFoundError,
} from "../../../utils/error/app-error";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("security.service");


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

    await recordAuditEvent({
      action: "auth.password_changed",
      entityId: (req as any).userId ?? "unknown",
      onWriteFailure: "log",
    });
    log.action("settings.security_updated", { userId: (req as any).userId ?? "unknown" });
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
    const result = await auth.api.enableTwoFactor({
      headers: fromNodeHeaders(req.headers),
      body: { password, issuer: "Oravanti" },
    });

    await recordAuditEvent({
      action: "auth.two_factor_enabled",
      entityId: (req as any).userId ?? "unknown",
      onWriteFailure: "log",
    });
    log.action("settings.security_updated", { userId: (req as any).userId ?? "unknown" });

    return result;
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

    await recordAuditEvent({
      action: "auth.two_factor_disabled",
      entityId: (req as any).userId ?? "unknown",
      onWriteFailure: "log",
    });
    log.action("settings.security_updated", { userId: (req as any).userId ?? "unknown" });
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

    await recordAuditEvent({
      action: "auth.session_revoked",
      entityId: (req as any).userId ?? "unknown",
      onWriteFailure: "log",
    });
    log.action("settings.security_updated", { userId: (req as any).userId ?? "unknown" });
  };
}
