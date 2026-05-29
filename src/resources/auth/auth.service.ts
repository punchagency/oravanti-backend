import { fromNodeHeaders } from "better-auth/node";
import { Request } from "express";
import { auth } from "../../auth";
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  ValidationError,
} from "../../utils/error/app-error";

type AuthServiceError = {
  message: string;
  status?: number;
};

const mapAuthError = (error: AuthServiceError) => {
  switch (error.status) {
    case 400:
      return new BadRequestError(error.message);
    case 401:
      return new AuthenticationError(error.message);
    case 409:
      return new ConflictError(error.message);
    case 422:
      return new ValidationError(error.message);
    default:
      return new ExternalServiceError(error.message);
  }
};

export class AuthService {
  emailSignUp = async (
    body: {
      email: string;
      password: string;
      rememberMe?: boolean;
    },
    req: Request,
  ) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.signUpEmail({
      headers: clientHeaders,
      body: {
        ...body,
        name: "User",
        callbackURL: process.env.EMAIL_VERIFICATION_CALLBACK_URL,
      },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      const errorCode = errorData.code as
        | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
        | "INVALID_EMAIL"
        | "PASSWORD_TOO_SHORT";

      const message = errorData.message || "Registration failed";

      switch (errorCode) {
        case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
          throw new ConflictError(message, errorData);

        case "INVALID_EMAIL":
        case "PASSWORD_TOO_SHORT":
          throw new BadRequestError(message, errorData);

        default:
          throw new Error(message);
      }
    }

    return response;
  };
}
