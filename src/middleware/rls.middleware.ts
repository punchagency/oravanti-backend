import { sql } from "drizzle-orm";
import { NextFunction, Response } from "express";
import { db } from "../db/client";
import { AuthRequest } from "./auth.middleware";

export const setFirmContext = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.firmId) {
    await db.execute(
      sql`SELECT set_config('app.current_firm_id', ${req.firmId}, false)`,
    );
  }
  next();
};
