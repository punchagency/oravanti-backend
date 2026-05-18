import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../config/db';
import { admins } from '../db/schema/admins';
import { AuthRequest } from './auth.middleware';

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const record = await db
    .select({ id: admins.id, firmId: admins.firmId })
    .from(admins)
    .where(eq(admins.userId, req.userId!))
    .limit(1);

  if (!record.length) {
    res.status(403).json({ message: 'Admin access required' });
    return;
  }

  req.adminId = record[0].id;
  req.firmId  = record[0].firmId;
  next();
};
