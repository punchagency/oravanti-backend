import { fromNodeHeaders } from "better-auth/node";
import { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { auth, getActiveOrganization } from "../auth";
import { systemDb } from "../db/client";
import { user } from "../db/schema/auth-schema";
import { AuthenticationError } from "../utils/error/app-error";
import { initializeTenantContext, setRequestContext } from "./request-context";

export const requireAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session?.user) {
    throw new AuthenticationError("Missing or invalid session");
  }

  const userId = session.user.id;

  // Look up user type to determine RLS strategy
  const userRecord = await systemDb
    .select({ accountType: user.accountType })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const accountType = userRecord[0]?.accountType;
  const isStaff = accountType === "staff" || accountType === "firm_admin";

  // Only staff users get org-scoped RLS (app.current_organization_id).
  // Clients/contractors get user-scoped RLS only (app.current_user_id).
  let organizationId: string | undefined;
  if (isStaff) {
    const activeOrganizationId = (session.session as { activeOrganizationId?: string })
      .activeOrganizationId;
    if (activeOrganizationId) {
      organizationId = activeOrganizationId;
    } else {
      const organization = await getActiveOrganization(userId);
      organizationId = organization?.id;
    }
  }

  setRequestContext({ userId, organizationId: organizationId ?? null });

  // Eagerly create the tenant-scoped connection so the db Proxy can delegate
  // to it for all subsequent queries in this request.
  if (organizationId || userId) {
    await initializeTenantContext();
  }

  next();
};
