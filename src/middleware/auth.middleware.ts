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
  /**
   * Oravanti's own staff, who operate the platform catalogue rather than a
   * firm. They get no tenant connection at all — see below.
   */
  const isPlatformAdmin = accountType === "platform_admin";

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
  //
  // A platform admin is deliberately excluded, and the exclusion is
  // load-bearing in both directions. A user-scoped connection would set
  // `app.current_user_id` and nothing else, under which every platform
  // catalogue policy evaluates `organization_id = current_org_id` against a
  // NULL and denies the row — so the CRM would read an empty catalogue and
  // fail every write. Without a tenant connection the `db` Proxy falls through
  // to `systemDb` (see the note in db/client.ts), which is the connection that
  // can write `organization_id IS NULL`. That is the platform tier's whole
  // access story, and it is why every service the CRM reuses works unchanged.
  if (!isPlatformAdmin && (organizationId || userId)) {
    await initializeTenantContext();
  }

  next();
};
