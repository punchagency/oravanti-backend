import { and, eq } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { admins } from "../db/schema/admins";
import { member } from "../db/schema/auth-schema";
import { staff } from "../db/schema/staff";
import { AuthorizationError } from "../utils/error/app-error";
import { db } from "./../db/client";
import { AuthRequest } from "./auth.middleware";

const hasAdminRole = (role: string) =>
  role
    .split(",")
    .map((currentRole) => currentRole.trim())
    .some((currentRole) => currentRole === "owner" || currentRole === "admin");

export const requireStaffOrAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.userId || !req.organizationId) {
    throw new AuthorizationError("Staff or admin access required");
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

  if (membership && hasAdminRole(membership.role)) {
    const [adminRecord] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(
          eq(admins.userId, req.userId),
          eq(admins.organizationId, req.organizationId),
        ),
      )
      .limit(1);

    req.adminId = adminRecord?.id;

    const [adminStaffRecord] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(
          eq(staff.userId, req.userId),
          eq(staff.organizationId, req.organizationId),
        ),
      )
      .limit(1);

    req.staffId = adminStaffRecord?.id;
    return next();
  }

  const [staffRecord] = await db
    .select({ id: staff.id, organizationId: staff.organizationId })
    .from(staff)
    .where(
      and(
        eq(staff.userId, req.userId),
        eq(staff.organizationId, req.organizationId),
      ),
    )
    .limit(1);

  if (staffRecord) {
    req.staffId = staffRecord.id;
    return next();
  }

  throw new AuthorizationError("Staff or admin access required");
};
