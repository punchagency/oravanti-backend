import { and, eq } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { db } from "../db/client";
import { admins } from "../db/schema/admins";
import { member, user } from "../db/schema/auth-schema";
import { staff } from "../db/schema/staff";
import { AuthorizationError } from "../utils/error/app-error";
import { AuthRequest } from "./auth.middleware";

const hasAdminRole = (role: string) =>
  role
    .split(",")
    .map((currentRole) => currentRole.trim())
    .some((currentRole) => currentRole === "owner" || currentRole === "admin");

const ensureAdminRecord = async (userId: string, organizationId: string) => {
  const [existing] = await db
    .select({ id: admins.id, organizationId: admins.organizationId })
    .from(admins)
    .where(
      and(eq(admins.userId, userId), eq(admins.organizationId, organizationId)),
    )
    .limit(1);

  if (existing) return existing;

  const [authUser] = await db
    .select({
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!authUser) return null;

  const [created] = await db
    .insert(admins)
    .values({
      userId,
      organizationId,
      firstName: authUser.name.split(" ")[0] || "Admin",
      lastName: authUser.name.split(" ").slice(1).join(" ") || "User",
      email: authUser.email,
      avatarUrl: authUser.image,
    })
    .onConflictDoNothing()
    .returning({ id: admins.id, organizationId: admins.organizationId });

  if (created) return created;

  const [byOrganization] = await db
    .select({ id: admins.id, organizationId: admins.organizationId })
    .from(admins)
    .where(eq(admins.organizationId, organizationId))
    .limit(1);

  return byOrganization ?? null;
};

export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.userId || !req.organizationId) {
    throw new AuthorizationError("Admin access required");
  }

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, req.userId),
        eq(member.organizationId, req.organizationId),
      ),
    )
    .limit(1);

  if (!membership || !hasAdminRole(membership.role)) {
    throw new AuthorizationError("Admin access required");
  }

  const adminRecord = await ensureAdminRecord(req.userId, req.organizationId);
  if (adminRecord) {
    req.adminId = adminRecord.id;
  }

  const [staffRecord] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.userId, req.userId),
        eq(staff.organizationId, req.organizationId),
      ),
    )
    .limit(1);

  req.staffId = staffRecord?.id;

  next();
};
