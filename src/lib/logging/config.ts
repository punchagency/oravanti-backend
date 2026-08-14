import type { LoggerOptions, LogLevel } from "./types";

/**
 * Shared configuration. Both drivers consume these exact values — that is
 * what makes the conformance suite meaningful rather than decorative.
 *
 * This module reads `process.env` directly and does NOT import
 * `src/config/env.ts`. That is deliberate: env.ts throws unless all 22
 * required application keys are present, and coupling to it would mean the
 * logger could not be constructed in a unit test, or by a script, without a
 * fully populated environment. Logging must work in the situations where you
 * most need it. The LOG_* keys are documented in .env.example.
 */

/**
 * Lower number = more severe. This is Winston's convention, and Winston will
 * not accept any other. Pino's own numbering is the reverse, which is exactly
 * why levels are declared once, here, instead of twice in the drivers.
 *
 * `fatal` and `trace` do not exist in Winston's defaults — omitting this map
 * is defect D2, a TypeError on the first `log.fatal()`.
 */
export const LEVELS: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

/** OpenTelemetry severity numbers, for Phase 7. */
export const OTEL_SEVERITY: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

export const LOG_LEVELS = Object.keys(LEVELS) as LogLevel[];

export const isLogLevel = (v: unknown): v is LogLevel =>
  typeof v === "string" && (LOG_LEVELS as string[]).includes(v);

export const REDACTED = "[REDACTED]";

/**
 * SECURITY CONTROL — changes here warrant security review.
 *
 * Matched on the leaf key, case-insensitively, at any depth. A top-level-only
 * check is defect D3: `RequestContext` carries `rawUserDEK`, a live encryption
 * key, so one `log.debug({ ctx })` would emit the key material as a Buffer.
 * Buffers are redacted under any key for the same reason.
 */
export const REDACT_KEYS = [
  // Encryption material
  "rawuserdek",
  "decrypteddek",
  "dek",
  "encryptionkey",
  "servermasterkey",
  "server_master_key_primary",
  "email_encryption_key",
  "payment_encryption_key",
  // Credentials and session
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "otp",
  "twofactorcode",
  "backupcode",
  "backupcodes",
  "authorization",
  "cookie",
  "set-cookie",
  // Client PII — legal and immigration data
  "ssn",
  "socialsecuritynumber",
  "aliennumber",
  "anumber",
  "passportnumber",
  "dateofbirth",
  "dob",
  "taxid",
  // Payment
  "accountnumber",
  "routingnumber",
  "creditcard",
  "cardnumber",
  "cvv",
] as const;

export const REDACT_KEY_SET: ReadonlySet<string> = new Set(REDACT_KEYS);

const readEnv = (key: string): string | undefined => {
  const value = process.env[key];
  return value?.trim() ? value.trim() : undefined;
};

/**
 * Reads LOG_* from the environment.
 *
 * An unrecognised LOG_LEVEL throws rather than falling back. A silent
 * fallback means believing you had raised the level when you had not, and
 * you find out during the incident you raised it for.
 */
export function loadLoggerOptions(
  overrides: Partial<LoggerOptions> = {},
): LoggerOptions {
  const rawLevel = readEnv("LOG_LEVEL") ?? "info";

  if (!isLogLevel(rawLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL "${rawLevel}". Expected one of: ${LOG_LEVELS.join(", ")}`,
    );
  }

  const nodeEnv = readEnv("NODE_ENV") ?? "development";

  return {
    level: rawLevel,
    pretty: readEnv("LOG_PRETTY") === "true",
    fileEnabled: readEnv("LOG_FILE_ENABLED") === "true",
    base: {
      service: "oravanti-api",
      env: nodeEnv,
      ...(readEnv("APP_VERSION") ? { version: readEnv("APP_VERSION") } : {}),
    },
    ...overrides,
  };
}
