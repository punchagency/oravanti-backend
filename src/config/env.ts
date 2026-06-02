import "dotenv/config";

const REQUIRED_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGIN",
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SMTP_EMAIL_ADDRESS",
  "SMTP_PASSWORD",
  "SUPABASE_STORAGE_BUCKET"
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

type AppEnv = Record<RequiredEnvKey, string> & {
  PROD_DATABASE_URL?: string;
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

  if (isProduction && !prodDatabaseUrl) {
    throw new Error("Missing required environment variable: PROD_DATABASE_URL");
  }

  return {
    ...values,
    ...(prodDatabaseUrl ? { PROD_DATABASE_URL: prodDatabaseUrl } : {}),
    databaseUrl: isProduction ? prodDatabaseUrl! : values.DATABASE_URL,
    isProduction,
  };
};

export const env = validateEnv();
