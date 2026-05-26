import { eq } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { admins } from "../db/schema/admins";
import { staff } from "../db/schema/staff";
import { db } from "./../db/client";
import { AuthRequest } from "./auth.middleware";
import { AuthorizationError } from "../errors/app-error";

export const requireStaffOrAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const adminRecord = await db
    .select({ id: admins.id, firmId: admins.firmId })
    .from(admins)
    .where(eq(admins.userId, req.userId!))
    .limit(1);

  if (adminRecord.length) {
    req.adminId = adminRecord[0].id;
    req.firmId = adminRecord[0].firmId;
    return next();
  }

  const staffRecord = await db
    .select({ id: staff.id, firmId: staff.firmId })
    .from(staff)
    .where(eq(staff.userId, req.userId!))
    .limit(1);

  if (staffRecord.length) {
    req.staffId = staffRecord[0].id;
    req.firmId = staffRecord[0].firmId;
    return next();
  }

  throw new AuthorizationError("Staff or admin access required");
};
