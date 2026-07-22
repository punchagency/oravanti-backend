# RLS & Tenant Isolation — Complete Setup Roadmap & Checklist

This document covers every prerequisite, migration, and configuration step required for the full RLS + tenant isolation system to work correctly.

---

## Phase 0: Database Prerequisites

### 0.1 PostgreSQL Version

- Required: PostgreSQL 15+ (for `RESTRICTIVE`/`PERMISSIVE` policy syntax)
- Verify: `SELECT version();`

### 0.2 Extensions

No special extensions required. All functions use built-in PostgreSQL features.

---

## Phase 1: RLS Functions (Must Exist Before Policies)

### 1.1 `get_current_organization_id()`

Returns the current organization ID from the session variable.

```sql
CREATE OR REPLACE FUNCTION get_current_organization_id()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_organization_id', true), '')::text;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

**What it does:**
- Reads `app.current_organization_id` session variable
- Returns `NULL` if empty (via `NULLIF`)
- `STABLE` — constant within a transaction (PostgreSQL optimization)
- `SECURITY DEFINER` — runs with function owner's privileges

### 1.2 `get_current_user_id()`

Returns the current user ID from the session variable.

```sql
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::text;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

**What it does:**
- Reads `app.current_user_id` session variable
- Returns `NULL` if empty
- Used for client/contractor user-ownership policies

### 1.3 Where These Functions Are Defined

**File:** `drizzle/migrations/0006_rls_consolidated.sql`

**Must be created BEFORE:**
- Any RLS policy that references them
- Any table DEFAULT that references them
- Any `ALTER TABLE ... SET DEFAULT` that references them

### 1.4 Verification

```sql
-- Test manually:
SET app.current_organization_id = 'test-org';
SELECT get_current_organization_id();  -- should return 'test-org'

SET app.current_organization_id = '';
SELECT get_current_organization_id();  -- should return NULL

RESET app.current_organization_id;
SELECT get_current_organization_id();  -- should return NULL
```

---

## Phase 2: Schema Changes (organization_id on All Tables)

### 2.1 Tables Requiring organization_id

Every table that stores tenant data must have an `organization_id` column.

**Required column definition:**
```sql
organization_id TEXT NOT NULL REFERENCES organization(id)
```

**With default (for defense-in-depth):**
```sql
organization_id TEXT NOT NULL DEFAULT get_current_organization_id() REFERENCES organization(id)
```

### 2.2 Complete Table List (66 tables)

#### Auth & Membership (6)
- [ ] `admin_sessions`
- [ ] `admins`
- [ ] `team`
- [ ] `member`
- [ ] `invitation`
- [ ] `staff`

#### Cases & Workflow (7)
- [ ] `cases`
- [ ] `certifications`
- [ ] `case_events`
- [ ] `case_workflow_steps`
- [ ] `case_notes`
- [ ] `case_timeline_events`
- [ ] `workflow_log`

#### Leads & Lead Events (5)
- [ ] `leads`
- [ ] `lead_events`
- [ ] `lead_document_links`
- [ ] `lead_tasks`
- [ ] `lead_timeline_events`

#### Clients (4)
- [ ] `clients`
- [ ] `client_companies`
- [ ] `client_contacts`
- [ ] `client_requests`

#### Documents (7)
- [ ] `documents`
- [ ] `document_versions`
- [ ] `document_case_links`
- [ ] `document_access`
- [ ] `document_requests`
- [ ] `external_submissions`
- [ ] `document_activity_logs`

#### Consultations & Fees (5)
- [ ] `consultations`
- [ ] `consultation_participants`
- [ ] `consultation_locations`
- [ ] `consultation_settings`
- [ ] `fee_agreements`

#### Questionnaires (7)
- [ ] `firm_questionnaire_sections`
- [ ] `firm_questionnaire_questions`
- [ ] `firm_questionnaire_logic_rules`
- [ ] `questionnaire_sends`
- [ ] `questionnaire_responses`
- [ ] `questionnaire_answers`
- [ ] `questionnaire_response_files`

#### Staff Availability (3)
- [ ] `staff_availability`
- [ ] `staff_availability_breaks`
- [ ] `staff_availability_overrides`

#### Conflict Checks & Assignments (2)
- [ ] `conflict_checks`
- [ ] `assignments`

#### Calendar & Time (2)
- [ ] `calendar_events`
- [ ] `time_entries`

#### Tasks (1)
- [ ] `tasks`

#### Companies (1)
- [ ] `companies`

#### AI & Config (2)
- [ ] `ai_error_flags`
- [ ] `ai_system_config`

#### Approvals & Workflows (2)
- [ ] `approval_workflows`
- [ ] `step_action_logs`

#### Permissions & Data Access (4)
- [ ] `module_permissions`
- [ ] `permission_audit_log`
- [ ] `data_access_controls`
- [ ] `financial_access_controls`

#### Adverse Parties (1)
- [ ] `adverse_parties`

#### Paralegal (3)
- [ ] `paralegal_profiles`
- [ ] `paralegal_activation_requirements`
- [ ] `paralegal_certification_gates`

#### Practice Areas & Subscriptions (2)
- [ ] `firm_practice_areas`
- [ ] `subscriptions`

#### Leave Requests (1)
- [ ] `leave_requests`

#### Email (1)
- [ ] `connected_email_account`

### 2.3 Migration Files

| Migration | Purpose | File |
|-----------|---------|------|
| 0003 | RLS function + permissive policies | `0003_rls_tenant_isolation.sql` |
| 0004 | `get_current_user_id()` + user ownership schema | `0004_rls_user_ownership.sql` |
| 0005 | Restrictive + permissive policies | `0005_rls_restrictive_policies.sql` |
| 0006 | Consolidated RLS (functions + policies) | `0006_rls_consolidated.sql` |
| 0007 | DEFAULT on all organization_id columns | `0007_org_id_defaults.sql` |

---

## Phase 3: RLS Policies — Complete Reference

### 3.1 Policy Types Explained

PostgreSQL RLS supports two policy types that combine using specific logic:

| Type | Logic | When Used |
|------|-------|-----------|
| `RESTRICTIVE` | AND — ALL restrictive policies must pass | Baseline filter for staff/firm_admin |
| `PERMISSIVE` | OR — ANY permissive policy can pass | Alternative access for clients/contractors |

**How they combine:**
```
Final result = (at least one PERMISSIVE passes) AND (ALL RESTRICTIVE pass)
```

**Why this matters:**
- Staff users: restrictive org policy passes → sees all org data
- Client users: restrictive org policy FAILS (no org set) → permissive self policy passes → sees only their data
- Contractor users: restrictive org policy FAILS → permissive assignment policy passes → sees only assigned data

### 3.2 Policy Evaluation Flow

```
Query arrives at PostgreSQL
  → RLS checks all policies on the table
  → Restrictive policies: ALL must evaluate to TRUE for the row
  → Permissive policies: at least ONE must evaluate to TRUE for the row
  → Final: (permissive passes) AND (restrictive passes)
  → If FALSE → row is filtered out (not visible)
```

### 3.3 Session Variable Dependencies

Every policy references one or both custom functions:

| Function | Session Variable | Set By | Used By |
|----------|-----------------|--------|---------|
| `get_current_organization_id()` | `app.current_organization_id` | `requireAuth` for staff/firm_admin | All restrictive org policies |
| `get_current_user_id()` | `app.current_user_id` | `requireAuth` for all users | All permissive user-ownership policies |

**Critical:** If neither function exists, ALL policies fail → no data visible.

---

### 3.4 Table-by-Table Policy Breakdown

#### Table: `cases`

**Policies:** 3 (1 restrictive + 2 permissive)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_cases_org` | RESTRICTIVE | ALL | `organization_id = get_current_organization_id()` | `organization_id = get_current_organization_id()` |
| `rls_cases_client` | PERMISSIVE | ALL | `client_user_id = get_current_user_id()` | `client_user_id = get_current_user_id()` |
| `rls_cases_contractor` | PERMISSIVE | ALL | `EXISTS (SELECT 1 FROM case_assignments ca WHERE ca.case_id = id AND ca.user_id = get_current_user_id())` | Same as USING |

**Access patterns:**
- Staff: org policy passes → sees all cases in their firm
- Client: org policy fails (NULL org) → client policy passes → sees only cases where they are `client_user_id`
- Contractor: org policy fails → contractor policy passes → sees only cases where they have an assignment in `case_assignments`

**Additional columns required:**
- `client_user_id TEXT` — links case to client's auth user ID
- `case_assignments` junction table — links cases to contractor user IDs

---

#### Table: `case_events`

**Policies:** 3 (1 restrictive + 2 permissive)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_case_events_staff` | RESTRICTIVE | ALL | `case_id IN (SELECT c.id FROM cases c WHERE c.organization_id = get_current_organization_id())` | Same as USING |
| `rls_case_events_client` | PERMISSIVE | ALL | `case_id IN (SELECT c.id FROM cases c WHERE c.client_user_id = get_current_user_id())` | Same as USING |
| `rls_case_events_contractor` | PERMISSIVE | ALL | `case_id IN (SELECT ca.case_id FROM case_assignments ca WHERE ca.user_id = get_current_user_id())` | Same as USING |

**Access pattern:** Inherited from parent `cases` table via subquery. If you can see the case, you can see its events.

---

#### Table: `case_record_notes`

**Policies:** 3 (1 restrictive + 2 permissive)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_case_record_notes_staff` | RESTRICTIVE | ALL | `case_id IN (SELECT c.id FROM cases c WHERE c.organization_id = get_current_organization_id())` | Same as USING |
| `rls_case_record_notes_client` | PERMISSIVE | ALL | `case_id IN (SELECT c.id FROM cases c WHERE c.client_user_id = get_current_user_id())` | Same as USING |
| `rls_case_record_notes_contractor` | PERMISSIVE | ALL | `case_id IN (SELECT ca.case_id FROM case_assignments ca WHERE ca.user_id = get_current_user_id())` | Same as USING |

**Access pattern:** Inherited from parent `cases` table via subquery.

---

#### Table: `clients`

**Policies:** 2 (1 restrictive + 1 permissive)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_clients_org` | RESTRICTIVE | ALL | `organization_id = get_current_organization_id()` | `organization_id = get_current_organization_id()` |
| `rls_clients_self` | PERMISSIVE | ALL | `user_id = get_current_user_id()` | `user_id = get_current_user_id()` |

**Access patterns:**
- Staff: org policy passes → sees all clients in their firm
- Client: org policy fails → self policy passes → sees only their own profile

**Additional column required:**
- `user_id TEXT` — links client record to auth user ID

---

#### Table: `leads`

**Policies:** 1 (restrictive only)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_leads_org` | RESTRICTIVE | ALL | `organization_id = get_current_organization_id()` | `organization_id = get_current_organization_id()` |

**Access pattern:** Staff only. Clients and contractors do not access leads.

---

#### Table: `lead_events`

**Policies:** 1 (restrictive only)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_lead_events_staff` | RESTRICTIVE | ALL | `lead_id IN (SELECT l.id FROM leads l WHERE l.organization_id = get_current_organization_id())` | Same as USING |

**Access pattern:** Inherited from parent `leads` table via subquery. Staff only.

---

#### Table: `lead_notes`

**Policies:** 1 (restrictive only)

| Policy Name | Type | FOR | USING | WITH CHECK |
|-------------|------|-----|-------|------------|
| `rls_lead_notes_staff` | RESTRICTIVE | ALL | `lead_id IN (SELECT l.id FROM leads l WHERE l.organization_id = get_current_organization_id())` | Same as USING |

**Access pattern:** Inherited from parent `leads` table via subquery. Staff only.

---

### 3.5 All Other Tables (66 total)

Every table with an `organization_id` column gets a **single restrictive org policy**:

```sql
CREATE POLICY rls_{table_name}_org ON {table_name}
  AS RESTRICTIVE
  FOR ALL
  USING (organization_id = get_current_organization_id())
  WITH CHECK (organization_id = get_current_organization_id());
```

**Tables with this standard policy (no special policies):**

| Table | Policy Name |
|-------|-------------|
| `admin_sessions` | `rls_admin_sessions_org` |
| `admins` | `rls_admins_org` |
| `team` | `rls_team_org` |
| `member` | `rls_member_org` |
| `invitation` | `rls_invitation_org` |
| `staff` | `rls_staff_org` |
| `certifications` | `rls_certifications_org` |
| `case_workflow_steps` | `rls_case_workflow_steps_org` |
| `case_notes` | `rls_case_notes_org` |
| `case_timeline_events` | `rls_case_timeline_events_org` |
| `workflow_log` | `rls_workflow_log_org` |
| `lead_document_links` | `rls_lead_document_links_org` |
| `lead_tasks` | `rls_lead_tasks_org` |
| `lead_timeline_events` | `rls_lead_timeline_events_org` |
| `client_companies` | `rls_client_companies_org` |
| `client_contacts` | `rls_client_contacts_org` |
| `client_requests` | `rls_client_requests_org` |
| `documents` | `rls_documents_org` |
| `document_versions` | `rls_document_versions_org` |
| `document_case_links` | `rls_document_case_links_org` |
| `document_access` | `rls_document_access_org` |
| `document_requests` | `rls_document_requests_org` |
| `external_submissions` | `rls_external_submissions_org` |
| `document_activity_logs` | `rls_document_activity_logs_org` |
| `consultations` | `rls_consultations_org` |
| `consultation_participants` | `rls_consultation_participants_org` |
| `consultation_locations` | `rls_consultation_locations_org` |
| `consultation_settings` | `rls_consultation_settings_org` |
| `fee_agreements` | `rls_fee_agreements_org` |
| `firm_questionnaire_sections` | `rls_firm_questionnaire_sections_org` |
| `firm_questionnaire_questions` | `rls_firm_questionnaire_questions_org` |
| `firm_questionnaire_logic_rules` | `rls_firm_questionnaire_logic_rules_org` |
| `questionnaire_sends` | `rls_questionnaire_sends_org` |
| `questionnaire_responses` | `rls_questionnaire_responses_org` |
| `questionnaire_answers` | `rls_questionnaire_answers_org` |
| `questionnaire_response_files` | `rls_questionnaire_response_files_org` |
| `staff_availability` | `rls_staff_availability_org` |
| `staff_availability_breaks` | `rls_staff_availability_breaks_org` |
| `staff_availability_overrides` | `rls_staff_availability_overrides_org` |
| `conflict_checks` | `rls_conflict_checks_org` |
| `assignments` | `rls_assignments_org` |
| `calendar_events` | `rls_calendar_events_org` |
| `time_entries` | `rls_time_entries_org` |
| `tasks` | `rls_tasks_org` |
| `companies` | `rls_companies_org` |
| `ai_error_flags` | `rls_ai_error_flags_org` |
| `ai_system_config` | `rls_ai_system_config_org` |
| `approval_workflows` | `rls_approval_workflows_org` |
| `step_action_logs` | `rls_step_action_logs_org` |
| `module_permissions` | `rls_module_permissions_org` |
| `permission_audit_log` | `rls_permission_audit_log_org` |
| `data_access_controls` | `rls_data_access_controls_org` |
| `financial_access_controls` | `rls_financial_access_controls_org` |
| `adverse_parties` | `rls_adverse_parties_org` |
| `paralegal_profiles` | `rls_paralegal_profiles_org` |
| `paralegal_activation_requirements` | `rls_paralegal_activation_requirements_org` |
| `paralegal_certification_gates` | `rls_paralegal_certification_gates_org` |
| `firm_practice_areas` | `rls_firm_practice_areas_org` |
| `subscriptions` | `rls_subscriptions_org` |
| `leave_requests` | `rls_leave_requests_org` |
| `connected_email_account` | `rls_connected_email_account_org` |

---

### 3.6 Complete Policy Summary

| Table | Restrictive Policies | Permissive Policies | Total |
|-------|---------------------|---------------------|-------|
| `cases` | 1 (`rls_cases_org`) | 2 (`rls_cases_client`, `rls_cases_contractor`) | 3 |
| `case_events` | 1 (`rls_case_events_staff`) | 2 (`rls_case_events_client`, `rls_case_events_contractor`) | 3 |
| `case_record_notes` | 1 (`rls_case_record_notes_staff`) | 2 (`rls_case_record_notes_client`, `rls_case_record_notes_contractor`) | 3 |
| `clients` | 1 (`rls_clients_org`) | 1 (`rls_clients_self`) | 2 |
| `leads` | 1 (`rls_leads_org`) | 0 | 1 |
| `lead_events` | 1 (`rls_lead_events_staff`) | 0 | 1 |
| `lead_notes` | 1 (`rls_lead_notes_staff`) | 0 | 1 |
| All other 59 tables | 1 each (`rls_{table}_org`) | 0 | 59 |
| **TOTAL** | **66** | **7** | **73** |

---

### 3.7 Policy Implementation Files

| File | Purpose |
|------|---------|
| `src/db/schema/rls.ts` | Drizzle `pgPolicy().link()` definitions for 7 tables with special policies |
| `drizzle/migrations/0006_rls_consolidated.sql` | Raw SQL: functions + RLS enable + all 73 policies |

**Why two files?**
- `rls.ts` — Drizzle-native, type-safe, auto-discovered by `drizzle-kit`
- `0006_rls_consolidated.sql` — Raw SQL reference, run manually, includes the dynamic loop for standard org policies

---

### 3.8 Policy Verification Queries

```sql
-- 1. Check if RLS is enabled on a table:
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname = 'cases';
-- Expected: relrowsecurity = t

-- 2. List all policies on a table:
SELECT polname, polpermissive, polcmd, polqual, polwithcheck
FROM pg_policy
WHERE polrelid = 'cases'::regclass;
-- Expected: 3 rows (rls_cases_org, rls_cases_client, rls_cases_contractor)

-- 3. Count policies per table:
SELECT
  c.relname AS table_name,
  COUNT(p.polname) AS policy_count,
  COUNT(p.polname) FILTER (WHERE p.polpermissive = 'R') AS restrictive_count,
  COUNT(p.polname) FILTER (WHERE p.polpermissive = 'P') AS permissive_count
FROM pg_class c
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relrowsecurity = true
GROUP BY c.relname
ORDER BY c.relname;

-- 4. Verify functions exist:
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_name IN ('get_current_organization_id', 'get_current_user_id');

-- 5. Test policy as staff (org set):
BEGIN;
SET app.current_organization_id = 'org-123';
SELECT count(*) FROM cases;  -- only org-123 cases
ROLLBACK;

-- 6. Test policy as client (no org set, user set):
BEGIN;
SET app.current_user_id = 'user-456';
SELECT count(*) FROM cases;  -- only cases where client_user_id = 'user-456'
ROLLBACK;

-- 7. Test cross-tenant isolation:
BEGIN;
SET app.current_organization_id = 'org-a';
SELECT count(*) FROM cases;  -- org-a only
ROLLBACK;

BEGIN;
SET app.current_organization_id = 'org-b';
SELECT count(*) FROM cases;  -- org-b only
ROLLBACK;
```

---

### 3.9 Policy Error Handling

PostgreSQL raises specific error codes when RLS denies access:

| Error Code | Meaning | Application Response |
|------------|---------|---------------------|
| `42501` | Insufficient privilege (RLS denied) | 403 `TENANT_ISOLATION_VIOLATION` |
| `44000` | WITH CHECK violation (INSERT/UPDATE failed) | 403 `TENANT_ISOLATION_VIOLATION` |

**File:** `src/middleware/error.middleware.ts` intercepts these PG error codes and returns a structured 403 response.

---

### 3.10 Policy Edge Cases

#### Case 1: Staff user with no org set
- `get_current_organization_id()` returns NULL
- `organization_id = NULL` → always FALSE
- Result: sees nothing (correct — staff must have an org)

#### Case 2: Client user with org set (shouldn't happen)
- `get_current_organization_id()` returns the org ID
- Restrictive org policy passes
- Permissive self policy also passes
- Result: sees all org data (too permissive — but `requireAuth` never sets org for clients)

#### Case 3: Contractor with no assignments
- `get_current_user_id()` returns their user ID
- Contractor policy: `EXISTS (SELECT 1 FROM case_assignments WHERE user_id = ...)` → FALSE
- Result: sees nothing (correct — no assigned cases)

#### Case 4: New table without RLS
- No policies created
- RLS enabled but no policies → all queries blocked
- Fix: add the table to the migration or create policies manually

#### Case 5: Table without organization_id
- No RLS enabled
- No policies created
- All users see all data (no tenant isolation)
- Fix: add `organization_id` column and run migration

---

## Phase 4: Session Variable Setup (Application Code)

### 4.1 How Session Variables Are Set

**File:** `src/db/client.ts` → `createTenantDb(organizationId, userId)`

```typescript
export async function createTenantDb(
  organizationId: string | null,
  userId: string | null,
) {
  const tenantClient = postgres(env.databaseUrl, { max: 1 });

  if (organizationId) {
    await tenantClient.unsafe(
      `SET app.current_organization_id = '${organizationId}'`,
    );
  }

  if (userId) {
    await tenantClient.unsafe(
      `SET app.current_user_id = '${userId}'`,
    );
  }

  return drizzle(tenantClient, { logger: false });
}
```

### 4.2 When Session Variables Are Set

**File:** `src/middleware/auth.middleware.ts`

- `requireAuth` middleware calls `createTenantDb()` for every request
- For staff/firm_admin: sets `app.current_organization_id`
- For all users: sets `app.current_user_id`
- Connection is stored in AsyncLocalStorage → `requestContextStore`

### 4.3 Request Context Flow

```
Request arrives
  → requireAuth middleware
    → queries user via systemDb (bypasses RLS)
    → determines account type (staff/firm_admin/client/contractor)
    → calls createTenantDb(organizationId, userId)
    → stores tenantDb in AsyncLocalStorage
  → resolveActorContext middleware
    → resolves staffId for staff/firm_admin
    → keeps staffId null for clients/contractors
  → requirePermission middleware
    → checks permissions against role
  → Controller handler
    → calls service methods
    → service uses `db` export (Proxy)
    → Proxy delegates to tenantDb (session variable is active)
    → all queries are tenant-scoped
```

---

## Phase 5: Application Code Requirements

### 5.1 Import Rules

| Use Case | Import |
|----------|--------|
| Normal business logic (cases, leads, documents, etc.) | `db` from `@/db/client` |
| Auth queries, DEK lookups, system operations | `systemDb` from `@/db/client` |
| Middleware (auth, permissions, etc.) | `systemDb` from `@/db/client` |

### 5.2 Query Requirements

**INSERT:**
- Can omit `organizationId` if table has `DEFAULT get_current_organization_id()`
- Recommended: pass `organizationId` explicitly for defense-in-depth

**SELECT:**
- Always filter by `organizationId` even though RLS handles it
- Defense-in-depth: works even if RLS is disabled or bypassed

**UPDATE:**
- Always include `organizationId` in WHERE clause
- Prevents cross-tenant updates

**DELETE:**
- Always include `organizationId` in WHERE clause
- Prevents cross-tenant deletes

### 5.3 Controller Boundary

Controllers pass `organizationId` from request context:

```typescript
const { organizationId } = getRequestContext();
await someService.doSomething(data, organizationId!);
```

This is the single point where `organizationId` enters the application code.

---

## Phase 6: Execution Checklist

### Step 1: Run Migrations (in order)

```bash
# 1. Create RLS functions + policies
npx drizzle-kit migrate

# Or manually run the SQL files:
# 1. drizzle/migrations/0006_rls_consolidated.sql
# 2. drizzle/migrations/0007_org_id_defaults.sql
```

### Step 2: Verify Functions Exist

```sql
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_name IN ('get_current_organization_id', 'get_current_user_id');
```

Expected: 2 rows returned.

### Step 3: Verify Defaults Are Set

```sql
SELECT table_name, column_default
FROM information_schema.columns
WHERE column_name = 'organization_id'
  AND table_schema = 'public'
  AND column_default LIKE '%get_current_organization_id%';
```

Expected: 66 rows returned (all tables with the default).

### Step 4: Verify RLS Is Enabled

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relrowsecurity = true;
```

Expected: All tenant tables show `relrowsecurity = t`.

### Step 5: Test Session Variable Flow

```sql
-- Simulate what the application does:
BEGIN;
SET app.current_organization_id = 'test-org-123';
SET app.current_user_id = 'user-456';

-- Verify functions read them:
SELECT get_current_organization_id();  -- 'test-org-123'
SELECT get_current_user_id();          -- 'user-456'

-- Test INSERT with default:
INSERT INTO cases (id, title, status) VALUES ('test-1', 'Test', 'open');
-- organization_id should be 'test-org-123'

-- Verify:
SELECT id, title, organization_id FROM cases WHERE id = 'test-1';
-- Should show organization_id = 'test-org-123'

ROLLBACK;  -- don't actually insert test data
```

### Step 6: Test Cross-Tenant Isolation

```sql
-- As org A:
BEGIN;
SET app.current_organization_id = 'org-a';
SELECT count(*) FROM cases;  -- only org-a cases

-- As org B (different connection):
BEGIN;
SET app.current_organization_id = 'org-b';
SELECT count(*) FROM cases;  -- only org-b cases

ROLLBACK;
ROLLBACK;
```

### Step 7: Test Application Endpoints

1. **Login as staff** → verify cases/leads are org-scoped
2. **Login as client** → verify only their cases are visible
3. **Login as contractor** → verify only assigned cases are visible
4. **Test INSERT** → verify organization_id is set correctly
5. **Test UPDATE** → verify can't update other org's records
6. **Test DELETE** → verify can't delete other org's records

---

## Phase 7: Common Issues & Troubleshooting

### Issue: "null value in column organization_id violates not-null constraint"

**Cause:** Session variable not set, DEFAULT returns NULL.

**Fix:** Ensure `requireAuth` middleware runs before any DB query. Check that `createTenantDb()` is called with a valid `organizationId`.

### Issue: "permission denied for table cases"

**Cause:** RLS policy rejecting the query.

**Fix:** Check that:
1. `app.current_organization_id` is set correctly
2. The user's organization matches the row's organization_id
3. RLS policies are applied correctly

### Issue: Cross-tenant data visible

**Cause:** Using `systemDb` instead of `db` for business queries.

**Fix:** Replace `systemDb` imports with `db` in service files. Only use `systemDb` for auth/DEK/system operations.

### Issue: DEFAULT not working on existing tables

**Cause:** `ALTER COLUMN ... SET DEFAULT` only affects new INSERTs, not existing rows.

**Fix:** Existing rows keep their current `organization_id`. The default only applies to new inserts.

---

## Phase 8: File Reference

| File | Purpose |
|------|---------|
| `src/db/client.ts` | `systemDb` (bypasses RLS), `db` (Proxy, RLS-aware), `createTenantDb()` |
| `src/db/schema/rls.ts` | Drizzle pgPolicy definitions linked to tables |
| `src/middleware/auth.middleware.ts` | Sets session variables, creates tenant connection |
| `src/middleware/request-context.ts` | AsyncLocalStorage for tenant context |
| `src/middleware/error.middleware.ts` | Intercepts PG RLS errors (42501, 44000) → 403 |
| `drizzle/migrations/0006_rls_consolidated.sql` | RLS functions + policies (raw SQL) |
| `drizzle/migrations/0007_org_id_defaults.sql` | DEFAULT on all organization_id columns |
| `.agents/DRIZZLE-POSTGRES-FUNCTIONS.md` | Drizzle + PostgreSQL functions reference |
| `.agents/SESSION-VARIABLES-AND-ORG-ID.md` | Session variables + organization_id in queries |
| `.agents/HOW-ORG-ID-DEFAULT-WORKS.md` | How defaults work for new records |

---

## Quick Reference: Execution Order

```
1. PostgreSQL 15+ running
2. Run 0006_rls_consolidated.sql
   → Creates get_current_organization_id()
   → Creates get_current_user_id()
   → Enables RLS on all tables
   → Creates all policies
3. Run 0007_org_id_defaults.sql
   → Adds DEFAULT to all 66 organization_id columns
4. Run drizzle-kit db:push (or migrate)
   → Applies schema changes from rls.ts
5. Application starts
   → requireAuth sets session variables per request
   → db Proxy delegates to tenant connection
   → all queries are tenant-scoped
6. Verify
   → Test cross-tenant isolation
   → Test INSERT defaults
   → Test SELECT filtering
   → Test UPDATE/DELETE scoping
```
