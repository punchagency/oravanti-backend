import { eq, and } from "drizzle-orm";
import { Request, Response, NextFunction } from "express";
import { db, systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { staff } from "../db/schema/staff";
import { getRequestContext, setRequestContext } from "./request-context";

export async function resolveActorContext(
  _req: Request,
  _res: Response,
  next: NextFunction,
) {
  const { userId, organizationId } = getRequestContext();

  if (!userId) {
    return next();
  }

  try {
    // Look up user type to determine how to resolve the actor
    const [userRecord] = await systemDb
      .select({ accountType: user.accountType })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const accountType = userRecord?.accountType;

    // Staff/firm_admin: resolve staffId from staff table
    if ((accountType === "staff" || accountType === "firm_admin") && organizationId) {
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
    }
    // Clients/contractors: no staffId, just userId (already set by requireAuth)
  } catch {
    setRequestContext({ staffId: null });
  }

  next();
}
