import { NextFunction, Request, Response } from "express";
import { NotFoundError } from "../utils/error/app-error";

export function notFoundMiddleware(
  req: Request,
  _res: Response,
  _next: NextFunction,
) {
  throw new NotFoundError(`${req.method} '${req.url}' not found`);
}
