import { fromNodeHeaders } from "better-auth/node";
import { NextFunction, Request, Response } from "express";
import { auth, getActiveOrganization } from "../auth";
import { AuthenticationError } from "../utils/error/app-error";
import { setRequestContext } from "./request-context";

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

  const activeOrganizationId = (session.session as { activeOrganizationId?: string })
    .activeOrganizationId;
  let organizationId: string | undefined;
  if (activeOrganizationId) {
    organizationId = activeOrganizationId;
  } else {
    const organization = await getActiveOrganization(userId);
    organizationId = organization?.id;
  }

  setRequestContext({ userId, organizationId: organizationId ?? null });

  next();
};
