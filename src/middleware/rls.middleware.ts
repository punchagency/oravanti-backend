import { Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../config/db';
import { AuthRequest } from './auth.middleware';

export const setFirmContext = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.firmId) {
    await db.execute(sql`SELECT set_config('app.current_firm_id', ${req.firmId}, false)`);
  }
  next();
};
