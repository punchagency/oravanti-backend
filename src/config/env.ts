import "dotenv/config";

const REQUIRED_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGIN",
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SMTP_EMAIL_ADDRESS",
  "SMTP_PASSWORD",
  "SERVER_MASTER_KEY_PRIMARY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "EMAIL_ENCRYPTION_KEY",
  "PAYMENT_ENCRYPTION_KEY",
  "EMAIL_VERIFICATION_CALLBACK_URL",
  "FRONTEND_APP_URL",
  "REDIS_URL"
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

type AppEnv = Record<RequiredEnvKey, string> & {
  PROD_DATABASE_URL?: string;
  SERVER_MASTER_KEY_OLD?: string;
  CONTRACTOR_PAYMENT_ENCRYPTION_KEY?: string;
  RESEND_API_KEY?: string;
  // Platform-owned Google Workspace service account used to mint Google Meet
  // links for all firms. Optional: when unset the Meet service falls back to a
  // placeholder link so non-Workspace/dev environments still function.
  GOOGLE_MEET_CLIENT_EMAIL?: string;
  GOOGLE_MEET_PRIVATE_KEY?: string;
  GOOGLE_MEET_IMPERSONATED_USER?: string;
  // Platform-owned Dropbox Sign (HelloSign) account, shared across all firms.
  // Optional: when the API key/client id are unset the leads module falls back
  // to the stub e-signature provider so dev environments still function.
  DROPBOX_SIGN_API_KEY?: string;
  DROPBOX_SIGN_CLIENT_ID?: string;
  // When true (default outside production) signature requests are created in
  // test mode and do not consume signature quota.
  DROPBOX_SIGN_TEST_MODE: boolean;
  // Dev-only escape hatch: skips the "payment received" requirement on the
  // case-opening gate for non-contingency fee agreements. Never active in
  // production.
  FEE_PAYMENT_GATE_BYPASS: boolean;
  databaseUrl: string;
  isProduction: boolean;
};

const readEnv = (key: string) => {
  const value = process.env[key];

  if (!value?.trim()) {
    return undefined;
  }

  return value.trim();
};

const validateEnv = (): AppEnv => {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !readEnv(key));

  if (missing.length) {
    throw new Error(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  const values = REQUIRED_ENV_KEYS.reduce(
    (acc, key) => {
      acc[key] = readEnv(key)!;
      return acc;
    },
    {} as Record<RequiredEnvKey, string>,
  );

  const port = Number(values.PORT);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  const isProduction = values.NODE_ENV === "production";
  const prodDatabaseUrl = readEnv("PROD_DATABASE_URL");
  const serverMasterKeyOld = readEnv("SERVER_MASTER_KEY_OLD");
  const contractorPaymentEncryptionKey = readEnv("CONTRACTOR_PAYMENT_ENCRYPTION_KEY");

  if (isProduction && !prodDatabaseUrl) {
    throw new Error("Missing required environment variable: PROD_DATABASE_URL");
  }

  const resendApiKey = readEnv("RESEND_API_KEY");
  const googleMeetClientEmail = readEnv("GOOGLE_MEET_CLIENT_EMAIL");
  const googleMeetPrivateKey = readEnv("GOOGLE_MEET_PRIVATE_KEY");
  const googleMeetImpersonatedUser = readEnv("GOOGLE_MEET_IMPERSONATED_USER");
  const dropboxSignApiKey = readEnv("DROPBOX_SIGN_API_KEY");
  const dropboxSignClientId = readEnv("DROPBOX_SIGN_CLIENT_ID");
  // Defaults to test mode everywhere except production so quota is never
  // consumed accidentally; set DROPBOX_SIGN_TEST_MODE=false to override.
  const dropboxSignTestMode = isProduction
    ? readEnv("DROPBOX_SIGN_TEST_MODE") === "true"
    : readEnv("DROPBOX_SIGN_TEST_MODE") !== "false";
  // Opt-in and forced off in production.
  const feePaymentGateBypass =
    !isProduction && readEnv("FEE_PAYMENT_GATE_BYPASS") === "true";

  return {
    ...values,
    ...(prodDatabaseUrl ? { PROD_DATABASE_URL: prodDatabaseUrl } : {}),
    ...(serverMasterKeyOld ? { SERVER_MASTER_KEY_OLD: serverMasterKeyOld } : {}),
    ...(contractorPaymentEncryptionKey ? { CONTRACTOR_PAYMENT_ENCRYPTION_KEY: contractorPaymentEncryptionKey } : {}),
    ...(resendApiKey ? { RESEND_API_KEY: resendApiKey } : {}),
    ...(googleMeetClientEmail ? { GOOGLE_MEET_CLIENT_EMAIL: googleMeetClientEmail } : {}),
    ...(googleMeetPrivateKey ? { GOOGLE_MEET_PRIVATE_KEY: googleMeetPrivateKey } : {}),
    ...(googleMeetImpersonatedUser ? { GOOGLE_MEET_IMPERSONATED_USER: googleMeetImpersonatedUser } : {}),
    ...(dropboxSignApiKey ? { DROPBOX_SIGN_API_KEY: dropboxSignApiKey } : {}),
    ...(dropboxSignClientId ? { DROPBOX_SIGN_CLIENT_ID: dropboxSignClientId } : {}),
    DROPBOX_SIGN_TEST_MODE: dropboxSignTestMode,
    FEE_PAYMENT_GATE_BYPASS: feePaymentGateBypass,
    databaseUrl: isProduction ? prodDatabaseUrl! : values.DATABASE_URL,
    isProduction,
  };
};

export const env = validateEnv();
