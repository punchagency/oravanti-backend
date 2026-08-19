import { REDACTED, REDACT_KEY_SET } from "./config";

/**
 * One recursive redactor, shared by both drivers.
 *
 * Fixes D3. The Winston draft checked `if (field in info)` — the top level
 * only — so `log.debug({ ctx })` with a RequestContext would have emitted
 * `rawUserDEK` in full as `{"type":"Buffer","data":[...]}`. Depth matters
 * because almost nothing is logged at the top level.
 */

const MAX_DEPTH = 8;

/** Errors do not survive JSON.stringify; `stack` is the part that matters. */
export interface SerialisedError {
  type: string;
  message: string;
  stack?: string;
  /** Postgres and HTTP libraries hang useful codes off the error. */
  code?: string | number;
  /**
   * What actually went wrong, when the top-level error is only a wrapper.
   *
   * Drizzle reports every failure as `Failed query: <sql>` and hangs the real
   * Postgres error — the one naming the missing column, the violated
   * constraint, the refused permission — off `cause`. Dropping it, as this did,
   * turns every database 500 into a stack trace with no reason in it: you can
   * see which query failed and never why. Nested, because wrappers wrap
   * wrappers.
   */
  cause?: SerialisedError;
}

/**
 * Fields Postgres sets on a driver error that say what to actually fix.
 * `detail` names the conflicting value, `constraint` and `column` name the
 * thing that rejected it, `hint` is Postgres's own suggestion.
 */
const PG_ERROR_FIELDS = [
  "detail",
  "hint",
  "constraint",
  "table",
  "column",
  "schema",
  "routine",
  "severity",
] as const;

const MAX_CAUSE_DEPTH = 5;

export function serialiseError(value: unknown, depth = 0): SerialisedError {
  if (value instanceof Error) {
    const out: SerialisedError = {
      type: value.name,
      message: value.message,
      stack: value.stack,
    };

    const source = value as unknown as Record<string, unknown>;

    const code = source.code;
    if (code !== undefined) out.code = code as string | number;

    for (const field of PG_ERROR_FIELDS) {
      const detail = source[field];
      if (detail !== undefined && detail !== null && detail !== "") {
        (out as unknown as Record<string, unknown>)[field] = detail;
      }
    }

    // Depth-capped so a cyclic or self-referential chain terminates.
    if (value.cause !== undefined && value.cause !== null && depth < MAX_CAUSE_DEPTH) {
      out.cause = serialiseError(value.cause, depth + 1);
    }

    return out;
  }

  return { type: typeof value, message: String(value) };
}

/**
 * Returns a structurally identical value with secrets replaced.
 *
 * - Any Buffer, under any key, becomes [REDACTED] — that is what catches
 *   `rawUserDEK` even if someone renames the field.
 * - Any key in REDACT_KEY_SET becomes [REDACTED], matched case-insensitively.
 * - Errors become { type, message, stack } so both drivers agree on shape.
 * - Depth is capped; cycles therefore terminate rather than hang.
 */
export function deepRedact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;

  // Buffer before the object branch: a Buffer IS an object, and walking one
  // yields its bytes as numeric keys — the leak this exists to prevent.
  if (Buffer.isBuffer(value)) return REDACTED;

  if (value instanceof Error) {
    return deepRedact({ ...serialiseError(value) }, depth + 1);
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "bigint") return value.toString();

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((entry) => deepRedact(entry, depth + 1));
  }

  if (value instanceof Map) {
    return deepRedact(Object.fromEntries(value), depth + 1);
  }

  if (value instanceof Set) {
    return deepRedact([...value], depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEY_SET.has(key.toLowerCase())
      ? REDACTED
      : deepRedact(entry, depth + 1);
  }
  return out;
}

/**
 * Redacts a log record's fields and normalises `err`.
 *
 * `err` is serialised before redaction so its stack survives, then redacted
 * so a secret interpolated into an error message still gets caught.
 */
export function prepareFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { err, ...rest } = fields;
  const out = deepRedact(rest) as Record<string, unknown>;

  if (err !== undefined) {
    out.err = deepRedact(serialiseError(err));
  }

  return out;
}
