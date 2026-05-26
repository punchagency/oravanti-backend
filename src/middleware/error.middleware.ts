import { NextFunction, Request, Response } from "express";
import { HttpException } from "../utils/http.exception";

export const errorMiddleware = (
  err: HttpException,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  // render the error page
  res.status(err.status || 500);

  console.log(err);

  res.json({
    success: false,
    message: err.message || "something went wrong",
  });
};
