import { NextFunction, Request, Response } from "express";
import { getErrorResponse } from "../errors";

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const { statusCode, body } = getErrorResponse(error);
  res.status(statusCode).json(body);
};
