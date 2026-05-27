import { and, desc, eq } from "drizzle-orm";
import {
  createUserClient,
  supabase,
  supabaseAdmin,
} from "../../../config/supabase";
import { db } from "../../../db/client";
import { admins, adminSessions } from "../../../db/schema";

export class SecurityService {
  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseDeviceInfo(userAgent: string): string {
    const browser = /Edg/.test(userAgent)
      ? "Edge"
      : /Chrome/.test(userAgent)
        ? "Chrome"
        : /Firefox/.test(userAgent)
          ? "Firefox"
          : /Safari/.test(userAgent)
            ? "Safari"
            : "Unknown Browser";

    const os = /Windows/.test(userAgent)
      ? "Windows"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Android/.test(userAgent)
          ? "Android"
          : /Mac/.test(userAgent)
            ? "macOS"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "Unknown OS";

    return `${browser} on ${os}`;
  }

  // ─── Change Password ─────────────────────────────────────────────────────────

  changePassword = async (
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) => {
    const adminRecord = await db
      .select({ email: admins.email })
      .from(admins)
      .where(eq(admins.userId, userId))
      .limit(1);

    if (!adminRecord.length) throw new Error("Admin not found");

    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: adminRecord[0].email,
      password: currentPassword,
    });
    if (verifyError) throw new Error("Current password is incorrect");

    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        password: newPassword,
      });
    if (updateError) throw new Error(updateError.message);
  };

  // ─── Two-Factor Authentication ───────────────────────────────────────────────

  get2FAStatus = async (userId: string) => {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw new Error(error.message);

    const factors = data.user?.factors ?? [];
    const totp = factors.find(
      (f) => f.factor_type === "totp" && f.status === "verified",
    );

    return { enabled: !!totp, factorId: totp?.id ?? null };
  };

  enroll2FA = async (accessToken: string) => {
    const userClient = createUserClient(accessToken);
    const { data, error } = await userClient.auth.mfa.enroll({
      factorType: "totp",
      issuer: "Oravanti",
    });
    if (error) throw new Error(error.message);
    return data;
  };

  verify2FA = async (accessToken: string, factorId: string, code: string) => {
    const userClient = createUserClient(accessToken);

    const { data: challenge, error: challengeError } =
      await userClient.auth.mfa.challenge({ factorId });
    if (challengeError) throw new Error(challengeError.message);

    const { error: verifyError } = await userClient.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) throw new Error(verifyError.message);
  };

  unenroll2FA = async (accessToken: string, factorId: string) => {
    const userClient = createUserClient(accessToken);
    const { error } = await userClient.auth.mfa.unenroll({ factorId });
    if (error) throw new Error(error.message);
  };

  // ─── Active Sessions ─────────────────────────────────────────────────────────

  getSessions = async (userId: string) => {
    return db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.userId, userId))
      .orderBy(desc(adminSessions.createdAt));
  };

  deleteSession = async (id: string, userId: string) => {
    await db
      .delete(adminSessions)
      .where(and(eq(adminSessions.id, id), eq(adminSessions.userId, userId)));
  };

  logSession = async (userId: string, userAgent: string, ipAddress: string) => {
    const isAdmin = await db
      .select({ id: admins.id, firmId: admins.firmId })
      .from(admins)
      .where(eq(admins.userId, userId))
      .limit(1);

    if (!isAdmin.length) return;

    await db.insert(adminSessions).values({
      userId,
      firmId: isAdmin[0].firmId,
      deviceInfo: this.parseDeviceInfo(userAgent),
      ipAddress,
    });
  };
}
