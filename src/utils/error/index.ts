import { Response } from "express";
import { AppError } from "./app-error";

const DEFAULT_ERROR_MESSAGE = "Internal server error";

export const isAppError = (error: unknown): error is AppError => {
  return error instanceof AppError;
};

export const getErrorResponse = (error: unknown, fallbackStatusCode = 500) => {
  if (isAppError(error)) {
    return {
      statusCode: error.statusCode,
      body: {
        message: error.message,
        success: false,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  // Anything that is not an AppError was not written to be read by a client.
  // Postgres errors name tables and constraints, driver errors name hosts, and
  // AWS SDK errors name buckets — none of that goes over the wire. The caller
  // logs the real error; the client gets a correlation id to quote at support.
  return {
    statusCode: fallbackStatusCode,
    body: {
      message: DEFAULT_ERROR_MESSAGE,
      success: false,
      code:
        fallbackStatusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
    },
  };
};

export const sendErrorResponse = (
  res: Response,
  error: unknown,
  fallbackStatusCode = 500,
) => {
  const { statusCode, body } = getErrorResponse(error, fallbackStatusCode);
  res.status(statusCode).json(body);
};
