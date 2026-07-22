import { NextFunction, Request, Response } from "express";
import { getErrorResponse } from "../utils/error";
import { HttpException } from "../utils/http.exception";

/**
 * PostgreSQL error codes thrown by Row-Level Security violations:
 *   42501 — Insufficient privilege (SELECT/UPDATE/DELETE blocked by USING clause)
 *   44000 — WITH CHECK OPTION violation (INSERT/UPDATE blocked by WITH CHECK clause)
 */
const RLS_ERROR_CODES = new Set(["42501", "44000"]);

function isPgError(error: unknown): error is { code: string; message: string; detail?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as any).code === "string"
  );
}

export const errorMiddleware = (
  error: HttpException,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) {
    return next(error);
  }

  // Intercept PostgreSQL RLS violations before standard error handling
  if (isPgError(error) && RLS_ERROR_CODES.has(error.code)) {
    console.error("[RLS Violation]", {
      code: error.code,
      message: error.message,
      detail: error.detail,
      url: req.originalUrl,
      method: req.method,
    });

    return res.status(403).json({
      status: "error",
      code: "TENANT_ISOLATION_VIOLATION",
      message: "Access denied: You are not authorized to perform actions on this resource.",
    });
  }

  // set locals, only providing error in development
  res.locals.message = error.message;
  res.locals.error = req.app.get("env") === "development" ? error : {};

  const { statusCode, body } = getErrorResponse(error);

  console.log({ body });

  res.status(statusCode).json(body);
};
