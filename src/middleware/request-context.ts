import { AsyncLocalStorage } from "node:async_hooks";
import { Request, Response, NextFunction } from "express";

interface RequestContext {
  ipAddress: string | null;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    null;

  requestContextStore.run({ ipAddress: ip }, () => {
    next();
  });
}

export function getRequestContext(): RequestContext {
  return requestContextStore.getStore() ?? { ipAddress: null };
}
