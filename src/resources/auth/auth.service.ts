import { fromNodeHeaders } from "better-auth/node";
import { Request } from "express";
import { auth } from "../../auth";
import {
  AuthenticationError,
  AuthorizationError,
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
  signUpWithEmail = async (
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

  signInWithEmail = async (email: string, password: string, req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.signInEmail({
      body: { email, password },
      headers: clientHeaders,
      returnHeaders: true,
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));

      const errorCode = errorData.code as
        | "INVALID_EMAIL_OR_PASSWORD"
        | "INVALID_PASSWORD"
        | "USER_NOT_FOUND"
        | "CREDENTIAL_ACCOUNT_NOT_FOUND"
        | "INVALID_EMAIL"
        | "PASSWORD_TOO_SHORT"
        | "PASSWORD_TOO_LONG"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR"
        | "EMAIL_NOT_VERIFIED";

      const message = errorData.message || "Registration failed";

      switch (errorCode) {
        // --- 1. Core Authentication Failures ---
        case "INVALID_EMAIL_OR_PASSWORD":
        case "INVALID_PASSWORD":
        case "USER_NOT_FOUND":
        case "CREDENTIAL_ACCOUNT_NOT_FOUND":
          throw new AuthenticationError(message, errorData);

        // --- 2. Input & Validation Failures ---
        case "INVALID_EMAIL":
        case "PASSWORD_TOO_SHORT":
        case "PASSWORD_TOO_LONG":
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);

        // --- 3. Account State / Security Restrictions ---
        case "EMAIL_NOT_VERIFIED":
          throw new AuthorizationError(message, errorData);

        // --- 4. Fallback for unexpected errors ---
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  verifyTOTP = async (code: string, req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.verifyTOTP({
      body: { code },
      headers: clientHeaders,
      returnHeaders: true,
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_CODE"
        | "TOTP_EXPIRED"
        | "MISSING_TOTP_CODE"
        | "VALIDATION_ERROR";

      const message = errorData.message || "TOTP verification failed";
      switch (errorCode) {
        case "INVALID_CODE":
          throw new AuthenticationError(message, errorData);

        default:
          throw new Error(message);
      }
    }

    return response;
  };

  signOut = async (req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.signOut({
      headers: clientHeaders,
      asResponse: true,
    });

    return response;
  };

  sendVerificationOTP = async ({
    email,
    type,
  }: {
    email: string;
    type: "sign-in" | "email-verification" | "forget-password" | "change-email";
  }) => {
    const response = await auth.api.sendVerificationOTP({
      body: { email, type },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_EMAIL"
        | "USER_NOT_FOUND"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to send verification code";

      switch (errorCode) {
        case "INVALID_EMAIL":
        case "USER_NOT_FOUND":
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new BadRequestError(message, errorData);

        default:
          throw new Error(message);
      }
    }

    return response;
  };

  resetPasswordWithOTP = async ({
    email,
    otp,
    password,
  }: {
    email: string;
    otp: string;
    password: string;
  }) => {
    const response = await auth.api.resetPasswordEmailOTP({
      body: { email, otp, password },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_TOKEN"
        | "OTP_EXPIRED"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Password reset failed";

      switch (errorCode) {
        case "INVALID_TOKEN":
        case "OTP_EXPIRED":
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new BadRequestError(message, errorData);

        default:
          throw new Error(message);
      }
    }

    return response;
  };

  changePassword = async (
    {
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    },
    req: Request,
  ) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.changePassword({
      headers: clientHeaders,
      body: { currentPassword, newPassword, revokeOtherSessions: true },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_CURRENT_PASSWORD"
        | "PASSWORD_TOO_SHORT"
        | "PASSWORD_TOO_LONG"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Password change failed";

      switch (errorCode) {
        case "INVALID_CURRENT_PASSWORD":
          throw new AuthenticationError(message, errorData);
        case "PASSWORD_TOO_SHORT":
        case "PASSWORD_TOO_LONG":
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  revokeSession = async (token: string, req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.revokeSession({
      headers: clientHeaders,
      body: { token },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "UNAUTHORIZED"
        | "INVALID_TOKEN"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Session revocation failed";

      switch (errorCode) {
        case "INVALID_TOKEN":
        case "UNAUTHORIZED":
          throw new AuthenticationError(message, errorData);
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  getSession = async (req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.getSession({
      headers: clientHeaders,
      asResponse: true,
    });

    return response;
  };

  refreshSession = async (req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.getSession({
      headers: clientHeaders,
      asResponse: true,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as "SESSION_EXPIRED" | "INVALID_SESSION";

      const message = errorData.message || "Session refresh failed";

      switch (errorCode) {
        case "SESSION_EXPIRED":
        case "INVALID_SESSION":
          throw new AuthenticationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  getActiveSessions = async (req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.listSessions({
      headers: clientHeaders,
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_TOKEN"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to retrieve sessions";

      switch (errorCode) {
        case "INVALID_TOKEN":
          throw new AuthenticationError(message, errorData);
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  enableTwoFactorAuth = async (password: string, req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.enableTwoFactor({
      headers: clientHeaders,
      body: { password, issuer: "Oravanti" },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_PASSWORD"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to enable 2FA";

      switch (errorCode) {
        case "INVALID_PASSWORD":
          throw new AuthenticationError(message, errorData);
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };

  disableTwoFactorAuth = async (password: string, req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.disableTwoFactor({
      body: {
        password,
      },
      headers: clientHeaders,
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_PASSWORD"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to describe 2FA";

      switch (errorCode) {
        case "INVALID_PASSWORD":
          throw new AuthenticationError(message, errorData);
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    return response;
  };
}
