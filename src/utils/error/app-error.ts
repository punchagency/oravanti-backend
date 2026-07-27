export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: ErrorDetails;

  constructor(
    message: string,
    statusCode = 500,
    code = "INTERNAL_SERVER_ERROR",
    details?: ErrorDetails,
    isOperational = true,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: ErrorDetails) {
    super(message, 400, "BAD_REQUEST", details);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: ErrorDetails) {
    super(message, 422, "VALIDATION_ERROR", details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required", details?: ErrorDetails) {
    super(message, 401, "AUTHENTICATION_ERROR", details);
  }
}

export class AuthorizationError extends AppError {
  constructor(
    message = "You do not have permission to perform this action",
    details?: ErrorDetails,
  ) {
    super(message, 403, "AUTHORIZATION_ERROR", details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: ErrorDetails) {
    super(message, 404, "NOT_FOUND", details);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", details?: ErrorDetails) {
    super(message, 409, "CONFLICT", details);
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    message = "External service request failed",
    details?: ErrorDetails,
  ) {
    super(message, 502, "EXTERNAL_SERVICE_ERROR", details);
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", details?: ErrorDetails) {
    super(message, 500, "INTERNAL_SERVER_ERROR", details, false);
  }
}

export class NotImplementedError extends AppError {
  constructor(message = "This feature is not yet available", details?: ErrorDetails) {
    super(message, 501, "NOT_IMPLEMENTED", details);
  }
}
