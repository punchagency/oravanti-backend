import { AsyncLocalStorage } from "node:async_hooks";
import { Request, Response, NextFunction } from "express";

export interface RequestContext {
  ipAddress: string | null;
  userId: string | null;
  organizationId: string | null;
  staffId: string | null;
  rawUserDEK: Buffer | null;
}

export const requestContextStore = new AsyncLocalStorage<RequestContext>();

export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
  requestContextStore.run({ ipAddress: ip, userId: null, organizationId: null, staffId: null, rawUserDEK: null }, () => next());
}

export function getRequestContext(): RequestContext {
  return requestContextStore.getStore() ?? { ipAddress: null, userId: null, organizationId: null, staffId: null, rawUserDEK: null };
}

export function getStaffId(): string | null { return getRequestContext().staffId; }

export function setRequestContext(updates: Partial<Pick<RequestContext, "userId" | "organizationId" | "staffId" | "rawUserDEK">>) {
  const store = requestContextStore.getStore();
  if (store) {
    if (updates.userId !== undefined) store.userId = updates.userId;
    if (updates.organizationId !== undefined) store.organizationId = updates.organizationId;
    if (updates.staffId !== undefined) store.staffId = updates.staffId;
    if (updates.rawUserDEK !== undefined) store.rawUserDEK = updates.rawUserDEK;
  }
}
