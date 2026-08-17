import { fromNodeHeaders } from "better-auth/node";
import { createCipheriv, createHash, randomBytes, randomUUID } from "crypto";
import { inArray } from "drizzle-orm";
import { Request } from "express";
import { auth } from "../../auth";
import { env } from "../../config/env";
import { db } from "../../db/client";
import {
  contractorCertificationDocuments,
  contractorIdentificationDocuments,
  contractorPaymentDetails,
  contractors,
  contractorSpecialties,
} from "../../db/schema/contractors";
import {
  documentAccess,
  documents,
  documentVersions,
} from "../../db/schema/documents";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { LogEvent, createModuleLogger } from "../../lib/logging/log";
import { ContractorSignUpBody } from "../../types/auth.types";
import {
  AuthenticationError,
  AuthorizationError,
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  ValidationError,
} from "../../utils/error/app-error";
import { storageService } from "../../utils/storage/storage.service";
import { AccountType } from "./enums";

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

const normalizeEmail = (email: string) => email.toLowerCase().trim();

const getPaymentEncryptionKey = () => {
  const secret =
    env.CONTRACTOR_PAYMENT_ENCRYPTION_KEY || env.PAYMENT_ENCRYPTION_KEY;

  if (!secret) {
    throw new ExternalServiceError("Payment encryption key is not configured");
  }

  return createHash("sha256").update(secret).digest();
};

const encryptPaymentValue = (value: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getPaymentEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value.trim(), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
};

const parseOptionalDate = (value?: string) => {
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError("Certification dates must be valid dates");
  }

  return parsed.toISOString().split("T")[0];
};

const getAuthUserId = (data: unknown) => {
  if (!data || typeof data !== "object") return null;

  const payload = data as {
    user?: { id?: string };
    id?: string;
  };

  return payload.user?.id || payload.id || null;
};

const safeStorageName = (name: string, originalFilename: string) => {
  const ext = originalFilename.includes(".")
    ? originalFilename.split(".").pop()
    : undefined;
  const base = name.trim().replace(/[^a-zA-Z0-9-_]+/g, "_") || "document";
  return `${Date.now()}-${base}${ext ? `.${ext}` : ""}`;
};

const buildContractorCertificationStoragePath = (
  userId: string,
  documentId: string,
  filename: string,
) => `${userId}/contractor-certifications/${documentId}/v1/${filename}`;

const buildContractorIdentificationStoragePath = (
  userId: string,
  documentId: string,
  filename: string,
) => `${userId}/contractor-identifications/${documentId}/v1/${filename}`;

const log = createModuleLogger("auth.service");

export class AuthService {
  private uploadToStorage = async (data: {
    storagePath: string;
    fileBuffer: Buffer;
    mimeType: string;
  }) => {
    await storageService.upload({
      key: data.storagePath,
      body: data.fileBuffer,
      contentType: data.mimeType,
    });
  };

  private removeFromStorage = async (storagePaths: string[]) => {
    await storageService.remove(storagePaths);
  };

  signUpWithEmail = async (
    body: {
      email: string;
      password: string;
      firstName?: string;
      lastName?: string;
      rememberMe?: boolean;
    },
    req: Request<any, any, any, { account_type?: AccountType }>,
  ) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const accountType = req.query.account_type;

    if (
      !accountType ||
      !["firm_admin", "contractor", "client"].includes(accountType)
    ) {
      log.warn(
        LogEvent.AUTH_SIGNUP_FAILED,
        { email: body.email, accountType, reason: "invalid_account_type" },
        "Sign-up rejected: account_type missing or not recognised",
      );
      throw new BadRequestError(
        "Invalid or missing account_type context query parameter.",
      );
    }

    const displayName =
      [body.firstName, body.lastName].filter(Boolean).join(" ").trim() ||
      "User";

    let response;
    try {
      response = await auth.api.signUpEmail({
        headers: clientHeaders,
        body: {
          email: body.email,
          password: body.password,
          name: displayName,
          accountType: accountType,
          onboardingState: accountType === "client" ? "completed" : "email_unverified",
          callbackURL: env.EMAIL_VERIFICATION_CALLBACK_URL,
        },
        asResponse: true,
      });
    } catch (error) {
      log.failure(LogEvent.AUTH_SIGNUP_FAILED, error, {
        email: body.email,
        accountType,
      });
      throw error;
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code;
      const message = errorData.message || "Registration failed";

      log.warn(
        LogEvent.AUTH_SIGNUP_FAILED,
        {
          email: body.email,
          accountType,
          code: errorCode,
          status: response.status,
        },
        `Sign-up refused for ${body.email}: ${message}`,
      );

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

    log.action(
      LogEvent.AUTH_SIGNUP,
      { email: body.email, accountType },
      `${accountType} account registered for ${body.email}`,
    );

    return response;
  };

  signUpContractorWithEmail = async (
    body: ContractorSignUpBody,
    certificationFiles: Express.Multer.File[],
    identificationFiles: Express.Multer.File[],
    req: Request,
  ) => {
    const email = normalizeEmail(body.email);
    const specialtyIds = [...new Set(body.specialtyIds)];
    const certificationDocuments = body.certificationDocuments;

    if (!body.consentedToBackgroundCheck) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "background_check_not_consented",
      });
      throw new ValidationError(
        "Contractors must consent to a background check",
      );
    }

    if (!body.recognizedDirectoryListingVerificationAccepted) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "directory_listing_not_accepted",
      });
      throw new ValidationError(
        "Contractors must accept directory listing verification checks",
      );
    }

    const hourlyRate = Number(body.desiredHourlyRate);
    if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "invalid_hourly_rate",
      });
      throw new ValidationError("desiredHourlyRate must be greater than zero");
    }

    const existingSpecialties = await db
      .select({ id: practiceAreaCaseTypes.id })
      .from(practiceAreaCaseTypes)
      .where(inArray(practiceAreaCaseTypes.id, specialtyIds));

    if (existingSpecialties.length !== specialtyIds.length) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "unknown_specialty",
        requested: specialtyIds.length,
        matched: existingSpecialties.length,
      });
      throw new ValidationError(
        "One or more contractor specialties are invalid",
      );
    }

    if (!certificationFiles.length) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "no_certification_files",
      });
      throw new ValidationError(
        "At least one certification file must be uploaded",
      );
    }

    if (certificationFiles.length !== certificationDocuments.length) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "certification_file_count_mismatch",
        files: certificationFiles.length,
        documents: certificationDocuments.length,
      });
      throw new ValidationError(
        "certificationFiles must match certificationDocuments by array order",
      );
    }

    if (identificationFiles.length !== 2) {
      log.warn(LogEvent.CONTRACTOR_REGISTRATION_REJECTED, {
        email,
        reason: "identification_file_count",
        files: identificationFiles.length,
      });
      throw new ValidationError(
        "Exactly two identification files must be uploaded",
      );
    }

    const preparedCertificationDocuments = certificationDocuments.map(
      (certification) => ({
        certificationName: certification.certificationName.trim(),
        issuingOrganization: certification.issuingOrganization?.trim(),
        issuedAt: parseOptionalDate(certification.issuedAt),
        expiresAt: parseOptionalDate(certification.expiresAt),
        verificationStatus: "pending" as const,
      }),
    );

    const preparedPaymentDetails =
      body.paymentDetails.paymentMethod === "paypal"
        ? {
            paymentMethod: "paypal" as const,
            paypalEmail: normalizeEmail(body.paymentDetails.paypalEmail),
          }
        : {
            paymentMethod: "bank_account" as const,
            accountHolderName: body.paymentDetails.accountHolderName.trim(),
            encryptedRoutingNumber: encryptPaymentValue(
              body.paymentDetails.routingNumber,
            ),
            encryptedAccountNumber: encryptPaymentValue(
              body.paymentDetails.accountNumber,
            ),
          };

    const clientHeaders = fromNodeHeaders(req.headers);
    const authResponse = await auth.api.signUpEmail({
      headers: clientHeaders,
      body: {
        email,
        password: body.password,
        rememberMe: body.rememberMe,
        name: `${body.firstName.trim()} ${body.lastName.trim()}`,
        accountType: "contractor",
        callbackURL: env.EMAIL_VERIFICATION_CALLBACK_URL,
      },
      asResponse: true,
    });

    if (!authResponse.ok) {
      const errorData = await authResponse.json().catch(() => ({}));

      const errorCode = errorData.code as
        | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
        | "INVALID_EMAIL"
        | "PASSWORD_TOO_SHORT";

      const message = errorData.message || "Contractor registration failed";

      log.warn(
        LogEvent.CONTRACTOR_REGISTRATION_FAILED,
        { email, code: errorCode, status: authResponse.status },
        `Contractor sign-up refused for ${email}: ${message}`,
      );

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

    const authData = await authResponse.json();
    const userId = getAuthUserId(authData);
    if (!userId) {
      log.failure(
        LogEvent.CONTRACTOR_REGISTRATION_FAILED,
        undefined,
        { email },
        "better-auth accepted the sign-up but returned no user id",
      );
      throw new ExternalServiceError("Contractor auth user was not returned");
    }

    const uploadedCertificationDocuments: Array<{
      documentId: string;
      title: string;
      storagePath: string;
      originalFilename: string;
      mimeType: string;
      fileSize: number;
      certificationName: string;
      issuingOrganization?: string;
      issuedAt?: string;
      expiresAt?: string;
      verificationStatus: "pending";
    }> = [];

    const uploadedIdentificationDocuments: Array<{
      documentId: string;
      title: string;
      storagePath: string;
      originalFilename: string;
      mimeType: string;
      fileSize: number;
      position: number;
      verificationStatus: "pending";
    }> = [];

    try {
      for (const [index, file] of certificationFiles.entries()) {
        const certification = preparedCertificationDocuments[index];
        const documentId = randomUUID();
        const title = certification.certificationName;
        const storagePath = buildContractorCertificationStoragePath(
          userId,
          documentId,
          safeStorageName(title, file.originalname),
        );
        await this.uploadToStorage({
          storagePath,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
        });

        uploadedCertificationDocuments.push({
          documentId,
          title,
          storagePath,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          ...certification,
        });
      }

      for (const [index, file] of identificationFiles.entries()) {
        const documentId = randomUUID();
        const position = index + 1;
        const title = `Identification document ${position}`;
        const storagePath = buildContractorIdentificationStoragePath(
          userId,
          documentId,
          safeStorageName(title, file.originalname),
        );
        await this.uploadToStorage({
          storagePath,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
        });

        uploadedIdentificationDocuments.push({
          documentId,
          title,
          storagePath,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          position,
          verificationStatus: "pending",
        });
      }

      const contractor = await db.transaction(async (tx) => {
        const [createdContractor] = await tx
          .insert(contractors)
          .values({
            userId,
            email,
            firstName: body.firstName.trim(),
            lastName: body.lastName.trim(),
            phoneNumber: body.phoneNumber.trim(),
            desiredHourlyRate: hourlyRate.toFixed(2),
            consentedToBackgroundCheck: body.consentedToBackgroundCheck,
            recognizedDirectoryListingVerificationAccepted:
              body.recognizedDirectoryListingVerificationAccepted,
            bio: body.bio.trim(),
            availability: body.availability,
            status: "pending",
          })
          .returning();

        await tx.insert(contractorSpecialties).values(
          specialtyIds.map((practiceAreaCaseTypeId) => ({
            contractorId: createdContractor.id,
            practiceAreaCaseTypeId,
          })),
        );

        if (preparedPaymentDetails.paymentMethod === "paypal") {
          await tx.insert(contractorPaymentDetails).values({
            contractorId: createdContractor.id,
            paymentMethod: "paypal",
            paypalEmail: preparedPaymentDetails.paypalEmail,
          });
        } else {
          await tx.insert(contractorPaymentDetails).values({
            contractorId: createdContractor.id,
            paymentMethod: "bank_account",
            accountHolderName: preparedPaymentDetails.accountHolderName,
            encryptedRoutingNumber:
              preparedPaymentDetails.encryptedRoutingNumber,
            encryptedAccountNumber:
              preparedPaymentDetails.encryptedAccountNumber,
          });
        }

        for (const identification of uploadedIdentificationDocuments) {
          const [document] = await tx
            .insert(documents)
            .values({
              id: identification.documentId,
              title: identification.title,
              category: "identity",
              createdByUserId: userId,
            })
            .returning();

          const [version] = await tx
            .insert(documentVersions)
            .values({
              documentId: document.id,
              filePath: identification.storagePath,
              originalFileName: identification.originalFilename,
              mimeType: identification.mimeType,
              fileSize: identification.fileSize,
              versionNumber: 1,
              uploadedByUserId: userId,
              virusScanStatus: "SKIPPED",
            })
            .returning();

          await tx
            .update(documents)
            .set({ currentVersionId: version.id, updatedAt: new Date() })
            .where(inArray(documents.id, [document.id]));

          await tx.insert(documentAccess).values({
            documentId: document.id,
            userId,
            permission: "ADMIN",
            grantedByUserId: userId,
          });
        }

        for (const certification of uploadedCertificationDocuments) {
          const [document] = await tx
            .insert(documents)
            .values({
              id: certification.documentId,
              title: certification.title,
              category: "supporting",
              createdByUserId: userId,
            })
            .returning();

          const [version] = await tx
            .insert(documentVersions)
            .values({
              documentId: document.id,
              filePath: certification.storagePath,
              originalFileName: certification.originalFilename,
              mimeType: certification.mimeType,
              fileSize: certification.fileSize,
              versionNumber: 1,
              uploadedByUserId: userId,
              virusScanStatus: "SKIPPED",
            })
            .returning();

          await tx
            .update(documents)
            .set({ currentVersionId: version.id, updatedAt: new Date() })
            .where(inArray(documents.id, [document.id]));

          await tx.insert(documentAccess).values({
            documentId: document.id,
            userId,
            permission: "ADMIN",
            grantedByUserId: userId,
          });
        }

        await tx.insert(contractorCertificationDocuments).values(
          uploadedCertificationDocuments.map((certification) => ({
            contractorId: createdContractor.id,
            documentId: certification.documentId,
            certificationName: certification.certificationName,
            issuingOrganization: certification.issuingOrganization,
            issuedAt: certification.issuedAt,
            expiresAt: certification.expiresAt,
            verificationStatus: certification.verificationStatus,
          })),
        );

        await tx.insert(contractorIdentificationDocuments).values(
          uploadedIdentificationDocuments.map((identification) => ({
            contractorId: createdContractor.id,
            documentId: identification.documentId,
            position: identification.position,
            verificationStatus: identification.verificationStatus,
          })),
        );

        return createdContractor;
      });

      log.action(
        LogEvent.CONTRACTOR_REGISTERED,
        {
          email,
          userId,
          contractorId: contractor.id,
          specialties: specialtyIds.length,
          certifications: uploadedCertificationDocuments.length,
          identifications: uploadedIdentificationDocuments.length,
          paymentMethod: preparedPaymentDetails.paymentMethod,
          status: contractor.status,
        },
        `Contractor ${email} registered and awaiting approval`,
      );

      return {
        headers: authResponse.headers,
        authData,
        contractor,
      };
    } catch (error) {
      const storagePaths = [
        ...uploadedCertificationDocuments,
        ...uploadedIdentificationDocuments,
      ].map((document) => document.storagePath);

      log.failure(LogEvent.CONTRACTOR_REGISTRATION_FAILED, error, {
        email,
        userId,
        uploadedFiles: storagePaths.length,
      });

      // The auth user is already committed and is deliberately not removed
      // here; only the orphaned uploads are. A cleanup failure must not mask
      // the original error, so it is logged and swallowed.
      await this.removeFromStorage(storagePaths).then(
        () =>
          log.info(LogEvent.CONTRACTOR_REGISTRATION_ROLLED_BACK, {
            email,
            userId,
            removedFiles: storagePaths.length,
          }),
        (cleanupError: unknown) =>
          log.failure(LogEvent.CONTRACTOR_ROLLBACK_FAILED, cleanupError, {
            email,
            userId,
            orphanedFiles: storagePaths.length,
          }),
      );

      throw error;
    }
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

      // Security-relevant: the code and the identifier are what make a
      // credential-stuffing run visible, and neither survives to the error
      // middleware — it only ever sees "Invalid email or password".
      log.warn(
        LogEvent.AUTH_LOGIN_FAILED,
        { email, code: errorCode, status: response.status },
        `Sign-in failed for ${email}: ${errorCode ?? message}`,
      );

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

    // A 200 here is not necessarily a completed sign-in: when the account has
    // 2FA on, better-auth answers with `twoFactorRedirect` and no session. The
    // clone is read instead of the response itself so the controller still
    // forwards an untouched body.
    const body = await response
      .clone()
      .json()
      .catch(() => ({}) as Record<string, unknown>);

    if (body.twoFactorRedirect) {
      log.info(
        LogEvent.AUTH_TWO_FACTOR_CHALLENGED,
        { email },
        `${email} passed credentials; second factor required`,
      );
    } else {
      log.action(LogEvent.AUTH_LOGIN, { email }, `${email} signed in`);
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

      log.warn(
        LogEvent.AUTH_TWO_FACTOR_FAILED,
        { method: "totp", code: errorCode, status: response.status },
        `Second factor rejected: ${errorCode ?? message}`,
      );

      switch (errorCode) {
        case "INVALID_CODE":
          throw new AuthenticationError(message, errorData);

        default:
          throw new Error(message);
      }
    }

    log.action(
      LogEvent.AUTH_TWO_FACTOR_VERIFIED,
      { method: "totp" },
      "Second factor verified",
    );

    return response;
  };

  signOut = async (req: Request) => {
    const clientHeaders = fromNodeHeaders(req.headers);

    const response = await auth.api.signOut({
      headers: clientHeaders,
      asResponse: true,
    });

    log.action(LogEvent.AUTH_LOGOUT, { status: response.status }, "Signed out");

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

      log.warn(
        LogEvent.AUTH_OTP_SEND_FAILED,
        { email, otpType: type, code: errorCode, status: response.status },
        `Could not send a ${type} code to ${email}: ${errorCode ?? message}`,
      );

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

    // The three flows that matter downstream get their own event; the
    // catch-all keeps the rest in the record rather than inventing a name.
    const sent =
      type === "email-verification"
        ? LogEvent.AUTH_EMAIL_VERIFICATION_SENT
        : type === "forget-password"
          ? LogEvent.AUTH_PASSWORD_RESET_REQUESTED
          : LogEvent.AUTH_OTP_SENT;

    log.action(sent, { email, otpType: type }, `Sent a ${type} code to ${email}`);

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
        "INVALID_TOKEN" | "OTP_EXPIRED" | "MISSING_FIELD" | "VALIDATION_ERROR";

      const message = errorData.message || "Password reset failed";

      log.warn(
        LogEvent.AUTH_PASSWORD_RESET_FAILED,
        { email, code: errorCode, status: response.status },
        `Password reset rejected for ${email}: ${errorCode ?? message}`,
      );

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

    log.action(
      LogEvent.AUTH_PASSWORD_RESET_COMPLETED,
      { email },
      `Password reset completed for ${email}`,
    );

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

      log.warn(
        LogEvent.AUTH_PASSWORD_CHANGE_FAILED,
        { code: errorCode, status: response.status },
        `Password change rejected: ${errorCode ?? message}`,
      );

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

    // `revokeOtherSessions: true` above means this also ended every other
    // session the user had — worth saying, because the sign-outs it causes
    // have no other explanation in the log.
    log.action(
      LogEvent.AUTH_PASSWORD_CHANGED,
      { otherSessionsRevoked: true },
      "Password changed; other sessions revoked",
    );

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
        "UNAUTHORIZED" | "INVALID_TOKEN" | "MISSING_FIELD" | "VALIDATION_ERROR";

      const message = errorData.message || "Session revocation failed";

      log.warn(
        LogEvent.AUTH_SESSION_REVOKE_FAILED,
        { code: errorCode, status: response.status },
        `Session revocation rejected: ${errorCode ?? message}`,
      );

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

    // The token itself is a live credential and is never logged.
    log.action(LogEvent.AUTH_SESSION_REVOKED, {}, "Session revoked");

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

      log.warn(
        LogEvent.AUTH_SESSION_EXPIRED,
        { code: errorCode, status: response.status },
        `Session refresh refused: ${errorCode ?? message}`,
      );

      switch (errorCode) {
        case "SESSION_EXPIRED":
        case "INVALID_SESSION":
          throw new AuthenticationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    // Debug, not action: the frontend refreshes on a timer, so at info this
    // one line would outnumber every real event in the log.
    log.debug(LogEvent.AUTH_SESSION_REFRESHED);

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
        "INVALID_TOKEN" | "MISSING_FIELD" | "VALIDATION_ERROR";

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
        "INVALID_PASSWORD" | "MISSING_FIELD" | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to enable 2FA";

      log.warn(
        LogEvent.AUTH_TWO_FACTOR_ENABLE_FAILED,
        { code: errorCode, status: response.status },
        `Enabling 2FA was refused: ${errorCode ?? message}`,
      );

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

    log.action(
      LogEvent.AUTH_TWO_FACTOR_ENABLED,
      {},
      "Two-factor authentication enabled",
    );

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
        "INVALID_PASSWORD" | "MISSING_FIELD" | "VALIDATION_ERROR";

      const message = errorData.message || "Failed to describe 2FA";

      log.warn(
        LogEvent.AUTH_TWO_FACTOR_DISABLE_FAILED,
        { code: errorCode, status: response.status },
        `Disabling 2FA was refused: ${errorCode ?? message}`,
      );

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

    // A security control being switched off. Always worth a record.
    log.action(
      LogEvent.AUTH_TWO_FACTOR_DISABLED,
      {},
      "Two-factor authentication disabled",
    );

    return response;
  };

  verifyTwoFactorBackupCode = async (
    {
      code,
    }: {
      code: string;
    },
    req: Request,
  ) => {
    const clientHeaders = fromNodeHeaders(req.headers);
    const response = await auth.api.verifyBackupCode({
      headers: clientHeaders,
      body: { code },
      asResponse: true,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.code as
        | "INVALID_BACKUP_CODE"
        | "INVALID_CODE"
        | "BACKUP_CODES_NOT_ENABLED"
        | "MISSING_FIELD"
        | "VALIDATION_ERROR";

      const message = errorData.message || "Backup code verification failed";

      log.warn(
        LogEvent.AUTH_TWO_FACTOR_FAILED,
        { method: "backup_code", code: errorCode, status: response.status },
        `Backup code rejected: ${errorCode ?? message}`,
      );

      switch (errorCode) {
        case "INVALID_BACKUP_CODE":
        case "INVALID_CODE":
          throw new AuthenticationError(message, errorData);
        case "BACKUP_CODES_NOT_ENABLED":
          throw new BadRequestError(message, errorData);
        case "MISSING_FIELD":
        case "VALIDATION_ERROR":
          throw new ValidationError(message, errorData);
        default:
          throw new Error(message);
      }
    }

    // A backup code being spent means the user lost their authenticator.
    // Worth surfacing on its own, not folded in with ordinary TOTP.
    log.action(
      LogEvent.AUTH_TWO_FACTOR_VERIFIED,
      { method: "backup_code" },
      "Signed in with a two-factor backup code",
    );

    return response;
  };
}
