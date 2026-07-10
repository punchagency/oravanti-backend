import { Response } from "express";

export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode: number = 200,
  meta?: Record<string, unknown>,
) {
  const body: Record<string, unknown> = { success: true };
  if (message) body.message = message;
  body.data = data !== undefined ? data : null;
  if (meta) Object.assign(body, meta);
  res.status(statusCode).json(body);
}
