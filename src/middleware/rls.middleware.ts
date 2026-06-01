import { sql } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { db } from "../db/client";
import { AuthRequest } from "./auth.middleware";

export const setFirmContext = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.organizationId) {
    await db.execute(
      sql`SELECT set_config('app.current_organization_id', ${req.organizationId}, false)`,
    );
  }
  next();
};
