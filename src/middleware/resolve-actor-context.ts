import { eq, and } from "drizzle-orm";
import { Request, Response, NextFunction } from "express";
import { db } from "../db/client";
import { staff } from "../db/schema/staff";
import { getRequestContext, setRequestContext } from "./request-context";

export async function resolveActorContext(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  const { userId, organizationId } = getRequestContext();

  if (userId && organizationId) {
    try {
      const [staffRecord] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(
          and(
            eq(staff.userId, userId),
            eq(staff.organizationId, organizationId),
          ),
        )
        .limit(1);

      setRequestContext({ staffId: staffRecord?.id ?? null });
    } catch {
      setRequestContext({ staffId: null });
    }
  }

  next();
}
