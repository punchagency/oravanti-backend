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
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  const message = error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE;

  return {
    statusCode: fallbackStatusCode,
    body: {
      message,
      code: fallbackStatusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR",
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
