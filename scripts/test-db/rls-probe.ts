/**
 * Credentials for the restricted role used to verify RLS.
 *
 * Kept in its own module (rather than in `setup.ts`) so importing them has no
 * side effects — `setup.ts` runs its `main()` on import.
 *
 * Why a separate role exists at all: Postgres skips row-level security for
 * superusers, for roles with BYPASSRLS, and for a table's owner unless FORCE
 * ROW LEVEL SECURITY is set. The application's role is all three, so policies
 * never engage on the normal connection. This role is none of them, which makes
 * it the only way to demonstrate the policies are correct.
 */
export const RLS_PROBE_USER = "oravanti_rls_probe";
export const RLS_PROBE_PASSWORD = "rls_probe_only";
