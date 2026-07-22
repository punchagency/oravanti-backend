# How get_current_organization_id() Works for New Records

## The Flow

```
1. POST /api/cases  (body: { title: "Test", status: "open" })
2. requireAuth middleware runs
   → queries user record via systemDb
   → determines user is staff
   → createTenantDb(organizationId, userId) is called
   → connection executes: SET app.current_organization_id = 'org-123'
   → this connection now has the session variable for its entire lifetime
3. Controller calls: db.insert(cases).values({ title: "Test", status: "open" })
   → notice: organizationId is NOT passed
4. PostgreSQL receives the INSERT
   → sees organization_id column has no value provided
   → evaluates the DEFAULT: get_current_organization_id()
   → function reads: current_setting('app.current_organization_id')
   → returns 'org-123'
   → row inserted with organization_id = 'org-123'
```

## Why It Works

- The `SET` command is **connection-scoped** — once set, it stays for the life of that connection
- The DEFAULT expression is evaluated **server-side** by PostgreSQL, where the session variable exists
- The function `get_current_organization_id()` is a simple `SELECT current_setting(...)` — no application code involved

## Connection Lifecycle in Our System

```
Request arrives → createTenantDb() → new single-connection client
                                     → SET app.current_organization_id = 'org-123'
                                     → drizzle instance bound to this connection
                                     → all queries on this connection see the session var
Request ends → connection is returned to pool / closed
```

## Important Caveat

If the `SET` command was never executed (e.g., `systemDb` is used, or a connection was created without calling `createTenantDb`), `current_setting('app.current_organization_id')` returns an empty string, and `NULLIF(..., '')` returns `NULL`. Since the column is `NOT NULL`, the INSERT **fails loudly** — which is the correct behavior.

## Summary

The database doesn't "record" the organization ID permanently — it's a **session variable** that exists only for the duration of that connection. The DEFAULT expression captures it at INSERT time and writes it to the row. After that, the value is stored in the row's `organization_id` column permanently.
