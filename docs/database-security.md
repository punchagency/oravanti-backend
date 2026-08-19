# Database security — RLS, roles, and the audit trail

> Canonical copy: `oravanti-be/docs/database-security.md`.
> Mirrored to `oravanti-fe/.claude/DATABASE_SECURITY.md` — keep the two identical.

This is the operational reference for how tenant isolation is enforced _in the
database_ rather than in application code: which Postgres roles exist, what each
one may do, how row-level security decides which rows a connection can see, and
the exact commands to set it all up in a fresh environment.

It is deliberately concrete. Where something is not yet true of the running
system, it says so.

---

## 0. Current status — read this first

| Thing                                              | State                                       |
| -------------------------------------------------- | ------------------------------------------- |
| Policies defined in the schema                     | ✅ 162 policies over 86 tables              |
| Coverage enforced in CI                            | ✅ `__tests__/unit/db/rls-coverage.test.ts` |
| `security:baseline` script written and dry-run     | ✅                                          |
| Baseline **applied** to dev / staging / production | ❌ not yet — see §8.3 and §8.5              |
| App connects as a role RLS applies to              | ❌ not yet — see §12                        |

Until the baseline is applied, **every policy in this document is inert on the
connection the application uses**. Postgres skips RLS for superusers, for roles
with `BYPASSRLS`, and for a table's owner unless the table is `FORCE`d — and the
role in `DATABASE_URL` today (`postgres` locally, the owner role in deployed
environments) is all three. The policies are correct and tested; they are not
yet load-bearing. Closing that gap is what §8 is for.

---

## 1. Two halves — what Drizzle owns, and what the script owns

Everything below splits cleanly in two, and confusing the halves is the most
common way this goes wrong.

|                                                           | Owned by Drizzle (`src/db/schema/*.ts`)           | Owned by `scripts/apply-security-baseline.ts` |
| --------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| Tables and columns                                        | ✅                                                | —                                             |
| `CREATE POLICY`                                           | ✅ (from `pgPolicy(...)`)                         | —                                             |
| `ENABLE ROW LEVEL SECURITY`                               | ✅ (automatic for any table with a linked policy) | —                                             |
| `FORCE ROW LEVEL SECURITY`                                | ❌                                                | ✅                                            |
| `get_current_organization_id()` / `get_current_user_id()` | ❌                                                | ✅                                            |
| Roles (`CREATE ROLE`, `ALTER ROLE`)                       | ❌                                                | ✅                                            |
| Grants (`GRANT` / `REVOKE`)                               | ❌                                                | ✅                                            |

A migration alone therefore produces a database with policies that never fire.
Both halves have to run. `npm run security:baseline` is idempotent and the
common case is a no-op, so it belongs in the deploy pipeline right after
migrations.

---

## 2. How RLS works here

### 2.1 The session variables

Every scoped connection begins by setting one or both of two Postgres session
variables. Nothing else identifies the caller to the database.

| Variable                      | Set for              | Meaning                        |
| ----------------------------- | -------------------- | ------------------------------ |
| `app.current_organization_id` | staff, firm admins   | "I am acting inside this firm" |
| `app.current_user_id`         | clients, contractors | "I am this person"             |

They are set with `set_config()`, never string-interpolated, and the values are
shape-checked (`/^[A-Za-z0-9_-]{1,128}$/`) before they go near a connection —
see `assertSafeId` in [src/db/client.ts](../src/db/client.ts).

### 2.2 The two helper functions

Every policy calls one of these. They are created by the baseline script, not by
a migration:

```sql
CREATE OR REPLACE FUNCTION public.get_current_organization_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::text;
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::text;
$$;
```

Three details that matter:

- **`missing_ok = true`** (the second argument to `current_setting`) makes an
  unset variable return `NULL` instead of raising. That is what lets an
  unscoped connection see _nothing_ rather than error.
- **`SECURITY DEFINER`** so the read works regardless of the caller's
  privileges.
- **`STABLE`** so the planner may cache the value within a statement.

### 2.3 The evaluation rule

This is the single most important thing to remember about Postgres RLS:

```
row is visible  ⟺  (at least one PERMISSIVE policy passes)
                    AND (every RESTRICTIVE policy passes)
```

Two consequences that have both actually bitten this codebase:

- A table with RLS enabled and **only restrictive policies denies every row.**
  There is no permissive policy to pass, so the left-hand side is false.
  (`leads` and `lead_notes` were in exactly this state until it was fixed; it
  never showed because RLS was inert on the owner connection.)
- A table with **only one permissive policy** is fine today and silently widens
  later — the second permissive policy someone adds is OR'd in.

The house rule that follows: **every table gets a restrictive policy and a
permissive policy, written as a pair.** The factories in `rls-tenant.ts` return
both so it cannot be done half-way.

### 2.4 The three caller identities

| Identity           | Sets                          | Restrictive org policy | Sees                                                |
| ------------------ | ----------------------------- | ---------------------- | --------------------------------------------------- |
| Staff / firm admin | `app.current_organization_id` | passes                 | every row in their firm                             |
| Client             | `app.current_user_id` only    | _fails_ (no org set)   | only the rows a `…_client` permissive policy grants |
| Contractor         | `app.current_user_id` only    | _fails_ (no org set)   | only rows reached through `case_assignments`        |

The client and contractor cases work _because_ the restrictive org policy fails.
That is why they only exist on the handful of bespoke tables in `rls.ts`
(`cases`, `case_record_notes`, `clients`, invoices, documents they were granted)
— on every table covered by `rls-tenant.ts`, a connection with only
`app.current_user_id` set sees nothing. That is the intended answer, not an
oversight.

---

## 3. The database roles

| Role                                  | Login | Flags                                                         | May do                                                                                                   | Used by                                              |
| ------------------------------------- | ----- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| owner (`postgres` / `oravanti_admin`) | yes   | SUPERUSER, owns every table                                   | everything; **RLS does not apply**                                                                       | migrations, `db:push`, the app _today_               |
| `oravanti_app`                        | yes   | NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOINHERIT | `SELECT/INSERT/UPDATE/DELETE` on all tables **except** `audit_events`, where it is `SELECT, INSERT` only | the application, once §12 lands                      |
| `oravanti_maintenance`                | yes   | NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOINHERIT | `SELECT, DELETE` on `audit_events`; `SELECT` on `organization`. Nothing else.                            | the audit retention job only                         |
| `oravanti_rls_probe`                  | yes   | NOSUPERUSER, NOBYPASSRLS, not an owner                        | full DML, but RLS applies                                                                                | `npm run check 07-rls` in the **test** database only |

### 3.1 The owner role

Whatever `DATABASE_URL` names. It owns the tables, so it is the role migrations
must run as. Postgres skips RLS for a table's owner unless the table carries
`FORCE ROW LEVEL SECURITY`, which is precisely why the baseline applies `FORCE`
— otherwise every policy would be decorative on the most privileged connection
in the system.

**It should not be the role the application runs as.** That it currently is, is
the gap in §12.

### 3.2 `oravanti_app`

The application account. The flags are re-asserted on **every** baseline run,
not only at creation:

```sql
ALTER ROLE "oravanti_app" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
```

A role that acquired `BYPASSRLS` out of band — a well-meaning `GRANT` during an
incident, a restored dump — is exactly the failure this file exists to prevent,
and it would be completely silent. Re-asserting costs nothing and closes it.

Its grants are issued broad-then-narrow:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oravanti_app;
-- …then, for each table in APPEND_ONLY_TABLES:
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM oravanti_app;
GRANT  SELECT, INSERT              ON public.audit_events TO   oravanti_app;
```

That order is deliberate. A table added later is **mutable by default** and has
to be named in `APPEND_ONLY_TABLES` to become immutable — which is the safe
direction for a grant script to fail in. `ALTER DEFAULT PRIVILEGES` covers
tables created after the baseline runs.

### 3.3 `oravanti_maintenance`

The only role that may delete an audit row, and it may do nothing else. It is
not a second application account.

Because RLS applies to it too and it sets no organization, it would otherwise
see no rows to delete — so the baseline gives it one explicit permissive policy,
scoped to the one table and to that role alone:

```sql
CREATE POLICY rls_audit_events_maintenance ON public.audit_events
  AS PERMISSIVE FOR ALL TO "oravanti_maintenance" USING (true);
```

### 3.4 `oravanti_rls_probe`

Test-database only, created by `npm run test:db:setup`. It exists because you
cannot demonstrate that a policy is correct using a connection the policy does
not apply to. `npm run check 07-rls` connects as this role, proves isolation,
and separately reports whether the normal role is subject to RLS at all.

---

## 4. From HTTP request to a scoped connection

```
requireAuth
  └─ resolves user, org, accountType
     └─ initializeTenantContext()            src/middleware/request-context.ts
        └─ createTenantDb(orgId, userId)     src/db/client.ts
           ├─ postgres(DATABASE_URL, { max: 1 })     ← one dedicated connection
           ├─ SELECT set_config('app.current_organization_id', $1, false)
           └─ SELECT set_config('app.current_user_id',         $1, false)
              └─ stored on the AsyncLocalStorage request context as `tenantDb`
                 └─ cleaned up (client.end()) when the response finishes
```

The exported `db` is a Proxy that picks a target per call, in this order:

1. **an open transaction** (`getTx()`), if one is active;
2. **the request's `tenantDb`**, if an AsyncLocalStorage context exists;
3. **`systemDb`** otherwise.

Query builders capture their session at construction time, so the builder has to
be created on the right instance — the Proxy cannot swap it afterwards.

### `systemDb` — the deliberate bypass

`systemDb` is a shared pool with no session variables set. It sees **every row
of every tenant**. Legitimate uses are narrow:

- better-auth lookups (`user`, `session`, `account`) — these run _before_ any
  tenant context exists, which is also why those tables are RLS-exempt;
- DEK injection and other platform-level bootstrapping;
- module initialisation and background work with no request in flight.

If you import `systemDb` in a service handling tenant data, you must filter by
`organization_id` by hand. In practice: import `db`.

---

## 5. Where the policies live

| File                                                          | Holds                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [src/db/schema/rls.ts](../src/db/schema/rls.ts)               | The 19 tables with **bespoke** policies — each needed a different predicate for staff, clients and contractors, so each is hand-written. |
| [src/db/schema/rls-tenant.ts](../src/db/schema/rls-tenant.ts) | **Everything else**, through three factories, plus the `RLS_EXEMPTIONS` registry.                                                        |

Neither module is re-exported from `src/db/schema/index.ts`. drizzle-kit already
scans the whole schema directory, so re-exporting registers every policy twice
and drizzle refuses the duplicate names. Import them by path.

### 5.1 Naming

```
rls_{table}_{scope}            rls_cases_org
rls_{table}_{role}             rls_cases_staff, rls_cases_client
rls_{table}_{role}_{variant}   rls_case_events_staff_access
```

By convention `_org` is the restrictive policy and `_staff` the permissive one.

### 5.2 The three factories in `rls-tenant.ts`

**`orgScoped(name, table)`** — the table has an `organization_id`:

```sql
USING      (organization_id = get_current_organization_id())
WITH CHECK (organization_id = get_current_organization_id())
```

`withCheck` mirrors `using` on purpose. Without it a tenant could `INSERT` a row
_into another organization_ and then be unable to see what they had just
written.

**`parentScoped(name, table, column, parentTable, parentColumn = "id")`** — no
org column; filtered through the parent that has one:

```sql
{column} IN (SELECT p.{parentColumn} FROM {parentTable} p
             WHERE p.organization_id = get_current_organization_id())
```

An `IN (SELECT …)` rather than a join, so it composes with whatever the query is
already doing. The parent must itself be org-scoped or this filters on nothing —
checked by the coverage test, not left to review.

**`throughDocument(name, table)`** — for the four tables hanging off
`documents`. A document has no `organization_id`; it is reachable if it is
linked to a case, linked to a lead, or the subject of a document request:

```sql
document_id IN (SELECT d.id FROM documents d WHERE
  EXISTS (… document_case_links → cases.organization_id …)
  OR EXISTS (… lead_document_links → leads.organization_id …)
  OR EXISTS (… document_requests.organization_id …))
```

### 5.3 Two tables that break the pattern

**`documents`** — reads are filtered by reachability; **writes are not.** A
document is inserted before anything links it to a matter, so a `withCheck` on
the same predicate would reject every upload. The row is unreachable to every
other tenant the moment it lands and reachable to this one only once linked, so
the read filter is where the tenancy actually lives.

**`profiles`** — keyed on the person, not the firm, and a person can belong to
more than one firm over time. Scoped to `user_id = get_current_user_id()`, OR'd
with the same-org staff directory.

### 5.4 The one gotcha in the factory pattern

> **Export policies individually. drizzle-kit silently drops arrays.**

drizzle-kit's scanner only recognises exported values that are policy
_instances_. An exported array of policies produces **no error and no policy** —
this cost 130 of the 162 policies once, and `drizzle-kit generate` reported
success. Hence the destructuring:

```ts
export const [rlsTasksOrg, rlsTasksStaff] = orgScoped("tasks", tasks);
```

Verify after any change to these files by generating to a scratch directory and
counting `CREATE POLICY` lines.

---

## 6. Coverage — 113 tables, and no third state

```
113 tables in the schema
 ├─  86 covered by 162 policies
 └─  27 named in RLS_EXEMPTIONS, each with a reason
```

There is no "not yet looked at". A table is protected or it is exempt, and being
exempt requires writing down why.

The exemptions fall into four groups:

| Group                    | Tables                                                                                                                    | Why                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| better-auth internals    | `user`, `session`, `account`, `verification`, `two_factor`, `organization`, `member`, `invitation`, `team`, `team_member` | Read **during** authentication, before any org or user setting exists on the connection. An org-scoped policy here would deny the very lookup that establishes the org and lock every account out. |
| Global reference data    | `practice_areas`, `practice_area_case_types`, `practice_area_subcategories`, the four `case_type_questionnaire*` tables   | Platform-authored taxonomy, identical for every firm.                                                                                                                                              |
| Content-addressed caches | `document_analyses`, `document_photo_comparisons`, `email_domain_cache`, `email_discovery_cache`                          | Keyed on a checksum — identical bytes resolve to one row whoever uploaded them. Reaching a row means already holding the checksum of a document you can see.                                       |
| Cross-tenant by design   | `payment_webhook_events`, `contractors` + its four child tables                                                           | Provider callbacks land before the tenant is resolved; a contractor is a platform-level person who works for many firms.                                                                           |

### How this is kept true

Two independent checks, deliberately looking at different things:

| Check                                     | Looks at              | Catches                                                                                                                                 |
| ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/unit/db/rls-coverage.test.ts`  | the **source**        | a new table in neither list; a stale or contradictory exemption; a perfunctory reason; a restrictive-only table; duplicate policy names |
| `npm run security:baseline` (verify pass) | the **live database** | a policy migration that was never applied; RLS disabled by hand; a table left unforced; a surviving mutating grant on `audit_events`    |

The schema being right is not evidence that the deployed database is. Both
matter.

---

## 7. Adding a new table — the checklist

1. Define the table as usual in `src/db/schema/`.
2. **Decide which list it belongs in.** CI fails until you do.
   - has `organization_id` → `orgScoped("my_table", myTable)` in `rls-tenant.ts`
   - reached through a parent → `parentScoped("my_table", myTable, "parent_id", "parent_table")`
   - hangs off `documents` → `throughDocument("my_table", myTable)`
   - needs client or contractor visibility → hand-write the pair in `rls.ts`
   - genuinely shouldn't be scoped → add to `RLS_EXEMPTIONS` **with a real reason**
3. Export the policies **individually** (destructure the factory result).
4. Must the table be append-only? Add it to `APPEND_ONLY_TABLES` in
   `scripts/apply-security-baseline.ts`.
5. `npm run db:generate` → confirm the migration contains both
   `ENABLE ROW LEVEL SECURITY` and your `CREATE POLICY` lines.
6. `npm run test:unit` → the coverage test should pass.
7. After deploying, `npm run security:baseline` to `FORCE` the new table.

---

## 8. Setting up from scratch

### 8.1 Clean slate — from an empty machine to a running system

Nothing installed, no database, fresh clone. Nine steps, in this order.

**Prerequisites:** Node 20+, Docker (or a local Postgres 16 and Redis 7), and
both repos cloned side by side — `oravanti-be/` and `oravanti-fe/` under the
same parent directory.

---

#### Step 1 — Postgres and Redis

```sh
cd oravanti-be
cp .env.db.example .env.db          # POSTGRES_DB=oravanti, POSTGRES_USER=oravanti_admin
docker compose up -d db redis
```

Only the two datastores. The `api` and `worker` services in
`docker-compose.yml` can wait until the schema exists.

Without Docker, create the database and its owner by hand:

```sql
CREATE ROLE oravanti_admin LOGIN PASSWORD 'oravanti_password';
CREATE DATABASE oravanti OWNER oravanti_admin;
```

That owner role is the one from §3.1 — the role migrations run as, and the one
RLS does not apply to until the baseline forces it.

---

#### Step 2 — dependencies and environment

```sh
npm install
cp .env.example .env
```

Now fill in `.env`. Two things to know before you start:

- `src/config/env.ts` validates **22 required variables** at import time and
  throws on the first one missing.
- `drizzle.config.ts` imports that same module — so **an incomplete `.env`
  blocks `db:push` as well as the server**, with an error that says nothing
  about Drizzle.

**`DATABASE_URL` is the one people get wrong.** The default in `.env.example`
(`postgres:password123@db:5432/postgres`) does not match `.env.db.example`
(`oravanti_admin` / `oravanti`). Pick one and be consistent:

```sh
# from the host machine
DATABASE_URL=postgresql://oravanti_admin:oravanti_password@localhost:5432/oravanti
# from inside docker compose
DATABASE_URL=postgresql://oravanti_admin:oravanti_password@db:5432/oravanti
```

Generate the four secrets:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # BETTER_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # SERVER_MASTER_KEY_PRIMARY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # EMAIL_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # PAYMENT_ENCRYPTION_KEY
```

**32 bytes, not 64.** `SERVER_MASTER_KEY_PRIMARY` is passed straight to
`aes-256-gcm`, which accepts a 32-byte key and throws `Invalid key length` on
anything else. A 64-byte key passes startup validation and then fails at first
login, when the DEK is provisioned.

And the two database role passwords, read once when the roles are created:

```sh
ORAVANTI_APP_DB_PASSWORD=…
ORAVANTI_MAINTENANCE_DB_PASSWORD=…
```

`R2_*`, `SMTP_*`, `GOOGLE_*` and `MICROSOFT_*` are required by the validator but
only exercised by the features that use them — placeholders are enough to get a
server running. Stripe, Dropbox Sign and Google Meet are genuinely optional and
fall back to stubs that say so.

---

#### Step 3 — the RLS helper functions, before the schema

```sh
npm run security:baseline -- --functions-only
```

**This step is easy to skip and the failure is confusing, so:** Postgres
validates a policy's expression when the policy is created. Apply the schema
before these two functions exist and the first policy migration dies with
`function get_current_organization_id() does not exist`, leaving the database
half-built.

The full baseline cannot go first either — it grants on `organization` and
`audit_events`, which do not exist yet. **Functions → schema → baseline** is the
only order that works, and `--functions-only` exists to make the first of those
three a command rather than pasted SQL.

---

#### Step 4 — schema and policies

```sh
npm run db:push
```

**Use `db:push` on a fresh database, not `db:migrate`.** `drizzle/migrations/`
is gitignored, so a fresh clone has no migration files and `db:migrate` applies
nothing at all — silently, reporting success. Run `npm run db:generate` first if
you want migration files to exist.

Expect roughly 113 tables, 86 `ENABLE ROW LEVEL SECURITY` statements and 162
`CREATE POLICY` statements.

---

#### Step 5 — the security baseline

```sh
npm run security:baseline -- --dry-run     # read the SQL first, at least once
npm run security:baseline
```

This creates both roles, applies `FORCE ROW LEVEL SECURITY`, issues the grants
and makes `audit_events` append-only. It ends by reading the database back:

```
── Verification ──────────────────────────────────────────
  ✓ both RLS helper functions exist
  ✓ role oravanti_app: nosuperuser, nobypassrls
  ✓ role oravanti_maintenance: nosuperuser, nobypassrls
  ✓ every RLS-enabled table is FORCEd
  ✓ every table is protected or exempt (86 with RLS, 27 exempt)
  ✓ audit_events is append-only for oravanti_app (INSERT, SELECT)
──────────────────────────────────────────────────────────
```

Any `✗` sets a non-zero exit code, so this is safe to gate a deploy on.

To enable the retention job, add the maintenance connection to `.env`:

```sh
MAINTENANCE_DATABASE_URL=postgresql://oravanti_maintenance:<password>@localhost:5432/oravanti
```

---

#### Step 6 — platform reference data

Global data, shared by every firm. No organization exists yet, and none is
needed. All idempotent.

```sh
npm run cli -- seed-taxonomy               # practice areas → subcategories → case types
npm run cli -- seed-line-presets           # invoice line presets (needs the taxonomy)
npm run cli -- seed-questionnaires         # one system questionnaire per case type
npm run cli -- seed-master-questionnaires  # case-type questionnaires from the master library
npm run cli -- seed-workflow-template      # the Personal Injury workflow template
npm run cli -- seed-intake-pipeline        # the default pipeline new leads are stamped with
```

Order matters only for `seed-line-presets`, which resolves case types. Run
`npm run cli` with no arguments for an interactive menu of everything available.

---

#### Step 7 — the first firm

There is no CLI shortcut for this, deliberately. Register through the frontend:

```sh
cd ../oravanti-fe
cp .env.example .env      # VITE_API_URL must match the backend's CORS_ORIGIN
npm install
npm run dev               # :5173
```

```sh
cd ../oravanti-be
npm run dev               # :3000
npm run worker:dev        # separate terminal, for queues and retention
```

Then sign up at `/signup` and complete `/onboarding/*`. Better Auth creates the
user, the organization and the owner membership together. Inserting an
organization row by hand skips the DEK provisioning in `injectUserDEK.ts` that
the crypto layer depends on, and the account will fail in non-obvious ways
later.

---

#### Step 8 — per-firm demo data (development only)

```sh
npm run cli -- seed-staff-teams        # staff members and teams
npm run cli -- seed-pi-cases           # five Personal Injury cases with clients
npm run cli -- demo-data seed          # broader linked demo data
```

Each takes an optional organization id; omit it and the CLI prompts you to pick
a firm. `npm run cli -- demo-data drop` reverses the last one.

---

#### Step 9 — verify the security layer

```sh
npm run typecheck
npm run test:unit           # includes the RLS coverage test
npm run test:db:setup       # builds the test database + oravanti_rls_probe
npm run check 07-rls        # proves tenant isolation
```

`07-rls` is the only one that demonstrates the policies are **correct** rather
than merely present, because it is the only one connecting as a role RLS
applies to. Note it runs against the _test_ database, not the one you just
built — `scripts/check.ts` overrides `DATABASE_URL` for the child process.

### 8.2 The whole thing, condensed

```sh
# ── backend ─────────────────────────────────────────────────────────────────
cd oravanti-be
cp .env.db.example .env.db
docker compose up -d db redis
npm install
cp .env.example .env                              # then fill it in — see step 2
npm run security:baseline -- --functions-only     # MUST precede the schema
npm run db:push                                   # not db:migrate on a fresh db
npm run security:baseline
npm run cli -- seed-taxonomy
npm run cli -- seed-line-presets
npm run cli -- seed-questionnaires
npm run cli -- seed-master-questionnaires
npm run cli -- seed-workflow-template
npm run cli -- seed-intake-pipeline
npm run dev

# ── frontend, separate terminal ─────────────────────────────────────────────
cd oravanti-fe && npm install && cp .env.example .env && npm run dev
# → sign up at http://localhost:5173/signup to create the first firm

# ── verify ──────────────────────────────────────────────────────────────────
cd oravanti-be
npm run test:unit && npm run test:db:setup && npm run check 07-rls
```

### 8.3 An environment that already exists

A database that predates this work has tables and data but no roles, no
`FORCE`, and possibly no helper functions. Skip the clean-slate steps and run:

```sh
npm run db:push                             # or db:generate && db:migrate — lands the policies
npm run security:baseline -- --dry-run
npm run security:baseline
```

The baseline creates the helper functions itself here, because the tables it
grants on already exist. The ordering trap in step 3 only applies to a database
with no schema.

Read §8.5 before doing this anywhere with real data in it.

### 8.4 The test database

```sh
npm run test:db:setup     # creates the database, the schema, the functions, and the probe role
npm run check 07-rls      # proves isolation using the probe role
```

`test:db:setup` is self-contained — it creates the helper functions itself, so
none of the ordering above applies. It reads `TEST_DATABASE_URL` and refuses to
run if it resolves to the same database as `DATABASE_URL`.

### 8.5 Staging and production — runbook

The order matters, and step 3 is the risky one.

```sh
# 1. Ship the policies first. FORCE with a missing policy takes a table dark.
npm run db:migrate

# 2. Confirm the policies actually landed, then read the SQL.
npm run security:baseline -- --dry-run

# 3. Apply. Production additionally requires the explicit flag.
NODE_ENV=production npm run security:baseline -- --confirm-production
```

**What makes step 3 the highest-risk change in the rollout:** it applies
`FORCE ROW LEVEL SECURITY`, which is the moment every policy stops being
theoretical. Any table whose policies are wrong — most sharply, any table with
restrictive policies and no permissive counterpart — goes dark instantly, and it
goes dark for the owner connection too, which is the one the app is currently
using.

Before running it in an environment that matters:

- confirm the `leads` / `lead_notes` permissive policies are present in the
  target database (`\d+ leads` in psql, or the query in §10);
- have the rollback ready.

**Rollback** — un-forcing is immediate and does not drop anything:

```sql
ALTER TABLE public.<table> NO FORCE ROW LEVEL SECURITY;   -- one table
```

Every table at once, if you need it:

```sql
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;
```

The grants and roles are harmless to leave in place while you investigate; the
one to restore if the application needs it back is:

```sql
GRANT UPDATE, DELETE ON public.audit_events TO oravanti_app;   -- undoes immutability
```

---

## 9. Audit immutability and retention

### 9.1 Append-only by grant, not by convention

`audit_events` is the firm's legal record. "No code deletes audit rows" is a
convention; the baseline makes it something the database refuses:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_events FROM oravanti_app;
GRANT  SELECT, INSERT              ON public.audit_events TO   oravanti_app;
```

A bug, an injected statement, or a careless migration running as the app role
now cannot rewrite history. Only `oravanti_maintenance` can remove a row, and
only for retention.

### 9.2 The retention job

[src/modules/shared/audit-retention.service.ts](../src/modules/shared/audit-retention.service.ts)

|                               |                                                  |
| ----------------------------- | ------------------------------------------------ |
| Default window, change events | **7 years** (`DEFAULT_AUDIT_RETENTION_YEARS`)    |
| Default window, access events | **2 years** (`DEFAULT_ACCESS_RETENTION_YEARS`)   |
| Per-firm override             | `organization.metadata` — **lengthening only**   |
| Batch size                    | 50,000 rows per pass                             |
| Schedule                      | daily in the worker (`src/queue/index.ts`)       |
| On demand                     | `npm run audit:retention`                        |
| Connection                    | `MAINTENANCE_DATABASE_URL`, never `DATABASE_URL` |

Two properties worth knowing:

- **A firm cannot shorten below the default.** `resolveWindow` takes
  `Math.max(configured, default)`, and every malformed value — bad JSON, `0`,
  a negative, `"forever"` — falls back to the default. A `0` cutoff would purge
  everything, and the job would report success.
- **It refuses to fall back to the app connection.** If
  `MAINTENANCE_DATABASE_URL` is unset the job logs "skipped" and stops. Running
  it on the app connection would work today and would hide the fact that the
  immutability grant was never applied.

---

## 10. Verifying by hand

Useful psql queries when something looks wrong.

**Which tables have RLS enabled, and which are forced?**

```sql
SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity, c.relname;
```

**What policies does one table carry, and of which kind?**

```sql
SELECT policyname, permissive, roles, cmd
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'leads';
```

Look for at least one `PERMISSIVE` row. Restrictive-only means zero rows visible.

**Which tables are restrictive-only?** (the dangerous shape)

```sql
SELECT tablename FROM pg_policies WHERE schemaname = 'public'
GROUP BY tablename HAVING count(*) FILTER (WHERE permissive = 'PERMISSIVE') = 0;
```

**What can the app role do to the audit trail?**

```sql
SELECT privilege_type FROM information_schema.table_privileges
WHERE table_schema='public' AND table_name='audit_events' AND grantee='oravanti_app';
-- expect exactly: INSERT, SELECT
```

**Do the helper functions exist?**

```sql
SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND proname IN ('get_current_organization_id','get_current_user_id');
```

**Simulate a scoped connection** (as a role RLS applies to):

```sql
SELECT set_config('app.current_organization_id', '<org-id>', false);
SELECT count(*) FROM cases;      -- should be that firm's cases only
RESET app.current_organization_id;
SELECT count(*) FROM cases;      -- should be 0
```

---

## 11. Troubleshooting

| Symptom                                                                               | Cause                                                                                                                             | Fix                                                                                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Every query returns 0 rows for a table                                                | RLS enabled with **restrictive policies only**                                                                                    | Add the permissive counterpart. Query in §10 finds them all.                                                   |
| `new row violates row-level security policy` on insert                                | `withCheck` predicate fails — usually the row's `organization_id` doesn't match the session, or the parent row is in another firm | Check the value being inserted against `get_current_organization_id()`.                                        |
| Policies appear to do nothing                                                         | Connection is superuser / `BYPASSRLS` / the table owner without `FORCE`                                                           | Expected before the baseline. Run `security:baseline`; verify with §10's forced-tables query.                  |
| `function get_current_organization_id() does not exist` **while applying the schema** | The helper functions must exist before the first `CREATE POLICY`                                                                  | `npm run security:baseline -- --functions-only`, then re-run `db:push` (§8.1 step 3).                          |
| `function get_current_organization_id() does not exist` **at query time**             | Baseline never ran in this database                                                                                               | `npm run security:baseline`.                                                                                   |
| `db:migrate` reports success but creates nothing                                      | `drizzle/migrations/` is gitignored — a fresh clone has no migration files                                                        | Use `npm run db:push`, or `npm run db:generate` first.                                                         |
| `Missing required environment variable: …` from `db:push`                             | `drizzle.config.ts` imports `src/config/env.ts`, which validates all 22                                                           | Complete `.env` — the schema tools need it as much as the server does.                                         |
| `Invalid key length` at first login                                                   | `SERVER_MASTER_KEY_PRIMARY` is not 32 bytes; `aes-256-gcm` takes exactly 32                                                       | Regenerate with `randomBytes(32).toString('hex')` — 64 hex characters.                                         |
| `drizzle-kit generate` emits far fewer policies than expected, no error               | Policies exported as an **array**                                                                                                 | Destructure into individual `export const` bindings (§5.4).                                                    |
| `duplicated policy name across public.<table>`                                        | An RLS module got re-exported from `schema/index.ts`                                                                              | Remove the re-export — drizzle already scans the directory.                                                    |
| Coverage test fails on a table you just added                                         | Working as designed                                                                                                               | Pick a list: a factory in `rls-tenant.ts`, a hand-written pair in `rls.ts`, or `RLS_EXEMPTIONS` with a reason. |
| Retention job logs "skipped"                                                          | `MAINTENANCE_DATABASE_URL` unset                                                                                                  | Set it, or leave it unset deliberately to disable retention.                                                   |
| Retention deletes nothing despite old rows                                            | Window resolved to the default, or the maintenance policy is missing                                                              | Check `organization.metadata`; confirm `rls_audit_events_maintenance` exists.                                  |
| Client/contractor sees nothing on some table                                          | Only `rls.ts` tables have client/contractor policies                                                                              | Intended. Widening is a per-table decision with a per-table predicate, written in `rls.ts`.                    |

---

## 12. Known gaps

**The application still connects as the owner role.** `DATABASE_URL` names a
superuser/owner, so even after `FORCE ROW LEVEL SECURITY` the app's own
connection is subject to policies only because of `FORCE` — and it retains
`UPDATE`/`DELETE` on `audit_events` that the baseline revoked from
`oravanti_app`, because it isn't `oravanti_app`. Switching the runtime
connection over is the second half of step 11 in `.claude/REMAINING-WORK.md`, and it
wants its own soak period. Until then, RLS here is defence in depth behind the
application's own filtering, not the only thing standing between tenants.

**`audit_events` is not partitioned.** Retention deletes in 50k-row batches,
which is fine at current volume. Monthly partitions with a `DETACH`-and-drop
retention step is the alternative if the table gets large enough that batched
deletes stop keeping up.

---

## Appendix — application roles are a separate layer

Database roles answer "which rows may this _connection_ touch". They say nothing
about which endpoints a person may call. That is `src/auth/permissions.ts`, a
better-auth access-control statement with its own vocabulary:

| App role    | `audit`      | `finance`              | `documents`    |
| ----------- | ------------ | ---------------------- | -------------- |
| `owner`     | read, export | full incl. `trust`     | full           |
| `admin`     | read, export | full incl. `trust`     | full           |
| `attorney`  | —            | read, create, log_time | read, download |
| `paralegal` | —            | read, log_time         | read           |
| `member`    | —            | —                      | —              |
| `client`    | —            | —                      | read, download |

The two layers are independent and both apply. A paralegal with `documents:
["read"]` is refused the download endpoint by the permission check; RLS
separately guarantees that the documents they _can_ read belong to their firm.
Neither substitutes for the other — the permission layer stops the wrong action,
RLS stops the wrong tenant.

---

## Related

- [src/db/schema/rls.ts](../src/db/schema/rls.ts) — bespoke policies, 19 tables
- [src/db/schema/rls-tenant.ts](../src/db/schema/rls-tenant.ts) — factories, coverage, `RLS_EXEMPTIONS`
- [src/db/client.ts](../src/db/client.ts) — `systemDb`, `createTenantDb`, the `db` Proxy
- [scripts/apply-security-baseline.ts](../scripts/apply-security-baseline.ts) — roles, grants, `FORCE`, verification
- [scripts/checks/07-rls.ts](../scripts/checks/07-rls.ts) — isolation proof against a real database
- [src/modules/shared/audit-retention.service.ts](../src/modules/shared/audit-retention.service.ts) — retention
- `CLAUDE.md` § _Auth & DB_ — the short version for day-to-day work
