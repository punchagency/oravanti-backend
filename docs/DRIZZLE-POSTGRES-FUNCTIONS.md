# Drizzle ORM — PostgreSQL Functions & RLS

## Key Finding

Drizzle does **not** have a native API for creating PostgreSQL functions/stored procedures.
This is a requested feature (GitHub discussions #2386, #2586) that remains unshipped as of 2026.

## What Drizzle Supports

- **`pgPolicy`** — define RLS policies in TypeScript via `.link()` to attach to existing tables
- **`db.execute(sql\`...\`)`** — run raw SQL at runtime (not for DDL/migrations)
- **Custom migrations** — empty migration files where you write raw SQL manually

## What Drizzle Does NOT Support

- `pgFunction()` or any API to declare PostgreSQL functions in schema
- Generating function DDL from TypeScript definitions
- First-class stored procedure / function support in migrations

## Our Approach (Scan2Plan RLS)

### Functions (raw SQL in custom migration)

Created in `drizzle/migrations/0006_rls_consolidated.sql`:

```sql
CREATE OR REPLACE FUNCTION get_current_organization_id()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::text;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::text;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

These must exist in the database **before** RLS policies reference them.

### Policies (Drizzle pgPolicy in schema)

Defined in `src/db/schema/rls.ts` using `pgPolicy().link(table)`:

- Restrictive policies (AND logic) — baseline org filter for staff
- Permissive policies (OR logic) — client/contractor access via subqueries
- Auto-discovered by `drizzle-kit` since the file is in the schema directory

### Execution Order

1. `0006_rls_consolidated.sql` — creates functions + enables RLS + creates policies (raw SQL)
2. `drizzle-kit db:push` — picks up schema changes including `pgPolicy` definitions from `rls.ts`
   - Functions must already exist before policies that reference them are created

### Runtime Session Setup

Set via `SET` commands on the PostgreSQL connection before any queries:

```sql
SET app.current_organization_id = '<org-id>';   -- staff/firm_admin only
SET app.current_user_id = '<user-id>';          -- all user types
```

Done in `src/db/client.ts` → `createTenantDb(organizationId, userId)`.

## Drizzle Config for Custom Migrations

```
drizzle-kit generate --custom --name=create-rls-functions
```

Generates an empty `.sql` file in the migrations directory where raw SQL is written manually.
