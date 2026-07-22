# PostgreSQL Session Variables & organization_id in Queries

## What is `SET app.current_organization_id = '...'`?

PostgreSQL **session variables** (also called **GUC parameters** — Grand Unified Configuration).

- Custom `app.*` variables are ignored by PostgreSQL itself — they exist purely for application use
- Persist for the life of the database connection (session)
- Set via `SET app.variable_name = value` or `SET LOCAL` (transaction-scoped)
- Read via `current_setting('app.variable_name')` in SQL
- Our RLS functions (`get_current_organization_id()`, `get_current_user_id()`) wrap these `current_setting()` calls

## Can `WITH CHECK` read from the session variable?

Yes. `WITH CHECK` evaluates on the **server side** where the session is set.

```sql
SET app.current_organization_id = 'org-123';
INSERT INTO cases (id, title, status) VALUES ('1', 'Test', 'open');
-- WITH CHECK sees organization_id = 'org-123' via get_current_organization_id()
```

But this only works if `organization_id` has a **DEFAULT** that reads the session variable:

```sql
ALTER TABLE cases ADD COLUMN organization_id TEXT
  DEFAULT (get_current_organization_id()) NOT NULL;
```

Without the default, the INSERT fails because `organization_id` is `NOT NULL` and no value was provided.

## With the default, you could remove `organizationId` from all INSERT calls

But there are tradeoffs:

| Keep `organizationId` in code | Remove it, rely on RLS + default |
|------|------|
| Defense-in-depth — explicit even if RLS misconfigured | Cleaner code, less boilerplate |
| Works even if session variable not set | BREAKS silently if session not set |
| Clear audit trail in code | Harder to debug |
| Safe during migration period | Requires all tables to have the default |

## Why keep `organizationId` in SELECT queries too?

The RLS `USING` clause already filters by `organization_id = get_current_organization_id()` automatically. So adding `WHERE organization_id = '...'` to SELECT queries is technically redundant when RLS is working correctly.

However, keeping it provides:

1. **Defense-in-depth** — if RLS is accidentally disabled, misconfigured, or bypassed (e.g., via `systemDb`), the explicit filter still prevents cross-tenant data leaks
2. **Clarity** — reading a query immediately shows "this is scoped to an organization" without needing to know about RLS policies
3. **Safe fallback** — during migration rollout or debugging, queries work correctly even without RLS enabled
4. **Index usage** — explicit `WHERE organization_id = X` lets PostgreSQL use the index directly without relying on the RLS filter being applied first

## Recommended approach

**Keep `organizationId` everywhere** (INSERT, SELECT, UPDATE, DELETE) for defense-in-depth.

Optionally add SQL defaults as a safety net:

```sql
-- Makes RLS-only inserts possible as a fallback
ALTER TABLE cases
  ALTER COLUMN organization_id SET DEFAULT (get_current_organization_id());
```

This way:
- Normal code: passes `organizationId` explicitly (defense-in-depth)
- If someone forgets: the default kicks in from the session variable (safety net)
- If RLS is off AND session is set: still works correctly
- If RLS is off AND session is NOT set: fails loudly (`NOT NULL` violation)

## References

- PostgreSQL docs: [Session and Local Variables](https://www.postgresql.org/docs/current/sql-set.html)
- PostgreSQL docs: [GUC Parameters](https://www.postgresql.org/docs/current/runtime-config-client.html)
- Our RLS functions: `drizzle/migrations/0006_rls_consolidated.sql`
- Our RLS policies: `src/db/schema/rls.ts`
