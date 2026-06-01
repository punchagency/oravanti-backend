import { fromNodeHeaders } from "better-auth/node";
import { NextFunction, Request, Response } from "express";
import { auth, getActiveOrganization } from "../auth";
import { AuthenticationError } from "../utils/error/app-error";

export interface AuthRequest extends Request {
  userId?: string;
  adminId?: string;
  staffId?: string;
  organizationId?: string;
}

export const requireAuth = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session?.user) {
    throw new AuthenticationError("Missing or invalid session");
  }

  req.userId = session.user.id;

  const activeOrganizationId = (session.session as { activeOrganizationId?: string })
    .activeOrganizationId;
  if (activeOrganizationId) {
    req.organizationId = activeOrganizationId;
  } else {
    const organization = await getActiveOrganization(session.user.id);
    req.organizationId = organization?.id;
  }

  next();
};
