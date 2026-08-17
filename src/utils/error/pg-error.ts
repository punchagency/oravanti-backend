/**
 * Recognising and describing PostgreSQL errors.
 *
 * App-wide because more than one caller needs it: the error middleware turns
 * an RLS refusal into a 403, retry logic needs to tell a deadlock from a
 * constraint violation, and the audit trail records why a write was rejected.
 * Each of those hand-rolling its own `"code" in error` check is how one of
 * them ends up missing a code the others handle.
 */

export interface PgError {
  code: string;
  message: string;
  detail?: string;
}

/**
 * PostgreSQL error codes thrown by Row-Level Security violations:
 *   42501 — Insufficient privilege (SELECT/UPDATE/DELETE blocked by USING)
 *   44000 — WITH CHECK OPTION violation (INSERT/UPDATE blocked by WITH CHECK)
 */
export const RLS_ERROR_CODES: ReadonlySet<string> = new Set(["42501", "44000"]);

export function isPgError(error: unknown): error is PgError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

/** A tenant boundary was crossed, or nearly was. */
export function isRlsViolation(error: unknown): boolean {
  return isPgError(error) && RLS_ERROR_CODES.has(error.code);
}

/**
 * The diagnostic fields a Postgres error carries beyond its message.
 *
 * These are the difference between "insert failed" and knowing which
 * constraint on which column rejected it — and they are exactly what must
 * never reach the client, because they describe the schema. Returned as flat
 * `pg_*` fields so they are searchable in a log, rather than buried inside a
 * stack string where only a human reading one record can find them.
 */
const PG_DIAGNOSTIC_KEYS = [
  "detail",
  "hint",
  "table",
  "column",
  "constraint",
  "schema",
  "routine",
  "where",
] as const;

export function pgContext(error: unknown): Record<string, unknown> {
  if (!isPgError(error)) return {};

  const source = error as unknown as Record<string, unknown>;
  const context: Record<string, unknown> = { pgCode: source.code };

  for (const key of PG_DIAGNOSTIC_KEYS) {
    if (source[key] !== undefined) context[`pg_${key}`] = source[key];
  }

  return context;
}
