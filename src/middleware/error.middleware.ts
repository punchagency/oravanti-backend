import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { LogEvent, logFailure, logWarning } from "../lib/logging/log";
import { getRequestContext, getRequestId } from "./request-context";
import { getErrorResponse, isAppError } from "../utils/error";
import type { AppError } from "../utils/error/app-error";
import { isRlsViolation, pgContext } from "../utils/error/pg-error";
import { HttpException } from "../utils/http.exception";
import { routePattern, safePath } from "../utils/request-info";
import { recordSpanException } from "../telemetry/span";


/**
 * The single place a failed request is recorded.
 *
 * 5xx carries the stack, because nobody can act on "Internal server error" —
 * the response deliberately says nothing (see utils/error/index.ts), so this
 * line is the only record of what actually broke. 4xx is a warn without a
 * stack: the client sent something invalid, which is expected traffic, and a
 * stack trace through express internals says nothing about why.
 */
function recordFailure(
  error: HttpException,
  req: Request,
  statusCode: number,
  code: unknown,
) {
  const route = routePattern(req, getRequestContext().mountPath);
  const where = {
    method: req.method,
    path: safePath(req),
    ...(route ? { route } : {}),
    status: statusCode,
    code,
    errorName: error?.name,
  };

  if (statusCode >= 500) {
    logFailure(LogEvent.HTTP_REQUEST_FAILED, error, {
      ...where,
      ...pgContext(error),
    });
    // Only 5xx marks the trace failed. A 4xx span reported as an error makes
    // the service's error rate measure its callers' mistakes, and the alert
    // built on it fires for a client sending a malformed filter.
    recordSpanException(error);
    return;
  }

  const appError = isAppError(error as unknown)
    ? (error as unknown as AppError)
    : undefined;

  logWarning(LogEvent.HTTP_REQUEST_REJECTED, {
    ...where,
    errorMessage: error?.message,
    // Validation failures carry the field-level detail saying which inputs
    // were wrong. Without it a 400 in the log is unactionable.
    ...(appError?.details ? { details: appError.details } : {}),
    // An AppError was thrown deliberately and says what it means, so a stack
    // through express internals adds nothing. Anything else reaching a 4xx was
    // not planned for, and the stack is the only thing that locates it.
    ...(appError ? {} : { err: error }),
  });
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

  // Every error response carries the correlation id. It is the only handle a
  // user has on a failure whose message we refuse to disclose — without it,
  // "something went wrong" is unsupportable.
  const requestId = getRequestId();

  // Intercept PostgreSQL RLS violations before standard error handling
  if (isRlsViolation(error)) {
    // A tenant-isolation breach is a security event, not a routine 403 — it
    // gets its own event so it can be alerted on separately from the noise of
    // ordinary permission failures.
    logFailure(
      LogEvent.SECURITY_RLS_VIOLATION,
      error,
      {
        ...pgContext(error),
        method: req.method,
        path: safePath(req),
      },
      "tenant isolation violation",
    );

    // A 403 by status, but a breach of the isolation boundary is ours, not the
    // caller's — the trace is marked failed so it surfaces alongside 5xx.
    recordSpanException(error, "tenant isolation violation");

    return res.status(403).json({
      status: "error",
      code: "TENANT_ISOLATION_VIOLATION",
      message: "Access denied: You are not authorized to perform actions on this resource.",
      requestId,
    });
  }

  // Multer (multipart upload) errors
  if (error instanceof multer.MulterError) {
    const isTooLarge = error.code === "LIMIT_FILE_SIZE";
    const statusCode = isTooLarge ? 413 : 400;
    const code = isTooLarge ? "FILE_TOO_LARGE" : "UPLOAD_ERROR";

    recordFailure(error, req, statusCode, code);

    return res.status(statusCode).json({
      status: "error",
      code,
      message: isTooLarge
        ? "File is too large"
        : error.message || "File upload failed",
      requestId,
    });
  }

  const { statusCode, body } = getErrorResponse(error);

  recordFailure(error, req, statusCode, body.code);

  res.status(statusCode).json({ ...body, requestId });
};
