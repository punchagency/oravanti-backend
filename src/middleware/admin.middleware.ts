import { eq } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { db } from "../db/client";
import { admins } from "../db/schema/admins";
import { AuthRequest } from "./auth.middleware";
import { AuthorizationError } from "../errors/app-error";

export const requireAdmin = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const record = await db
    .select({ id: admins.id, firmId: admins.firmId })
    .from(admins)
    .where(eq(admins.userId, req.userId!))
    .limit(1);

  if (!record.length) {
    throw new AuthorizationError("Admin access required");
  }

  req.adminId = record[0].id;
  req.firmId = record[0].firmId;
  next();
};
