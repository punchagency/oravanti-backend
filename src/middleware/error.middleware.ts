import { NextFunction, Request, Response } from "express";
import { getErrorResponse } from "../utils/error";
import { HttpException } from "../utils/http.exception";

export const errorMiddleware = (
  error: HttpException,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    return next(error);
  }

  // set locals, only providing error in development
  res.locals.message = error.message;
  res.locals.error = req.app.get("env") === "development" ? error : {};

  const { statusCode, body } = getErrorResponse(error);

  console.log({ body });

  res.status(statusCode).json(body);
};
