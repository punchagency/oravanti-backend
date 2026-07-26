// =============================================================================
// Row-Level Security (RLS) Policy Definitions
// =============================================================================
// This file defines all PostgreSQL RLS policies using Drizzle's pgPolicy API.
// When `drizzle-kit generate` runs, these policies are included in the migration.
//
// ─── How RLS Works in This App ──────────────────────────────────────────────
//
// Every request sets PostgreSQL session variables via the tenant DB connection:
//   - Staff/firm_admin: SET app.current_organization_id = '<org-uuid>'
//   - Client/contractor: SET app.current_user_id = '<user-uuid>'
//
// These session variables are read by helper functions:
//   - get_current_organization_id() — returns the org UUID or NULL
//   - get_current_user_id() — returns the user UUID or NULL
//
// PostgreSQL RLS evaluation:
//   1. ALL restrictive policies must pass (AND logic)
//   2. AT LEAST ONE permissive policy must pass (OR logic)
//   3. Final: (any permissive passes) AND (all restrictive pass)
//
// ─── Three User Roles ───────────────────────────────────────────────────────
//
// 1. STAFF / FIRM_ADMIN
//    - Sets: app.current_organization_id
//    - Does NOT set: app.current_user_id
//    - Sees: all rows in their organization
//    - Needs: restrictive org policy (baseline) + permissive org policy
//
// 2. CLIENT
//    - Sets: app.current_user_id
//    - Does NOT set: app.current_organization_id
//    - Sees: only rows they own (cases they hired the firm for, etc.)
//    - Needs: restrictive org policy FAILS (no org set) → permissive user policy PASSES
//
// 3. CONTRACTOR
//    - Sets: app.current_user_id
//    - Does NOT set: app.current_organization_id
//    - Sees: only rows assigned to them (cases via case_assignments, etc.)
//    - Needs: restrictive org policy FAILS (no org set) → permissive assignment policy PASSES
//
// ─── Policy Naming Convention ───────────────────────────────────────────────
//
//   rls_{table}_{scope}           — e.g., rls_cases_org
//   rls_{table}_{role}            — e.g., rls_cases_staff, rls_cases_client
//   rls_{table}_{role}_{variant}  — e.g., rls_case_events_staff_access
//
// ─── Coverage ───────────────────────────────────────────────────────────────
//
// Currently covered tables (7):
//   cases, case_events, case_record_notes, clients,
//   leads, lead_events, lead_notes
//
// See .agents/plan-rls-remaining-tables.md for the full audit of uncovered tables.
//
// Prerequisites:
//   - Custom PostgreSQL functions (get_current_organization_id, get_current_user_id)
//     must exist in the database before policies are applied.
//     Created by: 0006_rls_consolidated.sql
//   - RLS must be enabled on tables via:
//     ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
//     Done dynamically by: 0006_rls_consolidated.sql (for all org-scoped tables)
// =============================================================================

import { sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

// Import tables that need RLS policies
import {
  cases,
  caseEvents,
  caseRecordNotes,
} from "./cases";
import { clients } from "./clients";
import { leads, leadEvents, leadNotes } from "./leads";

// =============================================================================
// Helper: SQL references to custom PostgreSQL RLS functions
// =============================================================================
// These functions are created by migration 0006_rls_consolidated.sql.
// They safely read PostgreSQL session variables set per-request by the app.
// Returns NULL if the session variable is not set.

/** Reads app.current_organization_id — used by all org-scoped policies */
const currentOrgId = sql`get_current_organization_id()`;

/** Reads app.current_user_id — used by client/contractor permissive policies */
const currentUserId = sql`get_current_user_id()`;


// =============================================================================
// cases table
// =============================================================================
// The cases table is the central entity in the system. It has four user roles:
//
//   RESTRICTIVE org policy (baseline):
//     Staff: sees all cases where organization_id matches their org ✓
//     Client: organization_id is NULL (no org set) → FAILS ✗
//     Contractor: organization_id is NULL (no org set) → FAILS ✗
//
//   PERMISSIVE staff policy:
//     Staff: organization_id matches → PASSES ✓
//     (Client/Contractor never match this because they don't set org)
//
//   PERMISSIVE client policy:
//     Staff: client_user_id doesn't match their user_id → doesn't help
//     Client: client_user_id = current user → PASSES ✓
//     Contractor: client_user_id doesn't match → FAILS ✗
//
//   PERMISSIVE contractor policy:
//     Staff: not assigned to cases as contractor → doesn't help
//     Client: not in case_assignments → FAILS ✗
//     Contractor: in case_assignments WHERE user_id = current user → PASSES ✓

/**
 * RESTRICTIVE policy: Cases must belong to the current organization.
 *
 * This is the BASELINE filter. It applies to ALL users (staff, client, contractor).
 * For staff: passes because they set app.current_organization_id matching the case.
 * For client/contractor: fails because they don't set app.current_organization_id,
 * so get_current_organization_id() returns NULL, which never matches any case.
 *
 * This means client/contractor access relies entirely on the permissive policies below.
 * PostgreSQL requires: ALL restrictive pass AND ≥1 permissive pass.
 */
export const rlsCasesOrg = pgPolicy("rls_cases_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(cases);

/**
 * PERMISSIVE policy: Staff can access all cases in their organization.
 *
 * This is the PERMISSIVE counterpart to the restrictive org policy.
 * Without this, staff would be denied because PostgreSQL requires ≥1 permissive pass.
 * The restrictive org policy alone is not enough — staff need a permissive policy too.
 *
 * Staff: organization_id = their org → PASSES ✓
 * Client/Contractor: don't set org, so this never matches → doesn't affect them
 *
 * Added in: 0008_rls_permissive_staff_policies.sql
 */
export const rlsCasesStaff = pgPolicy("rls_cases_staff", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(cases);

/**
 * PERMISSIVE policy: Client can access cases where they are the client.
 *
 * Client sets app.current_user_id (but NOT app.current_organization_id).
 * The restrictive org policy fails for them, but this permissive policy passes:
 *   client_user_id = get_current_user_id() → their own cases ✓
 *
 * Staff: client_user_id doesn't match their user_id → doesn't help
 * Contractor: client_user_id doesn't match → doesn't help
 */
export const rlsCasesClient = pgPolicy("rls_cases_client", {
  as: "permissive",
  for: "all",
  using: sql`client_user_id = ${currentUserId}`,
  withCheck: sql`client_user_id = ${currentUserId}`,
}).link(cases);

/**
 * PERMISSIVE policy: Contractor can access cases they are assigned to.
 *
 * Contractor sets app.current_user_id (but NOT app.current_organization_id).
 * The restrictive org policy fails for them, but this permissive policy passes:
 *   EXISTS (SELECT 1 FROM case_assignments WHERE case_id = id AND user_id = current_user) ✓
 *
 * The case_assignments junction table links contractors to specific cases.
 * Staff: not in case_assignments as a contractor → doesn't help
 * Client: not in case_assignments → doesn't help
 */
export const rlsCasesContractor = pgPolicy("rls_cases_contractor", {
  as: "permissive",
  for: "all",
  using: sql`EXISTS (
    SELECT 1 FROM case_assignments ca
    WHERE ca.case_id = id AND ca.user_id = ${currentUserId}
  )`,
  withCheck: sql`EXISTS (
    SELECT 1 FROM case_assignments ca
    WHERE ca.case_id = id AND ca.user_id = ${currentUserId}
  )`,
}).link(cases);


// =============================================================================
// case_events table
// =============================================================================
// Case events are an append-only audit trail. Access is inherited from the
// parent case — if you can see the case, you can see its events.
//
// No one creates events directly on this table. Events are created by:
//   - logCaseEvent() in case-events.service.ts
//   - logEvent() in workflow.service.ts
//
// Policies use a subquery to check the parent case's organization or owner.

/**
 * RESTRICTIVE policy: Case events must belong to a case in the current organization.
 *
 * Filters by: case_id → parent case → organization_id = current org
 * Staff: passes (org matches) ✓
 * Client/Contractor: fails (no org set) ✗
 *
 * Note: This is a restrictive policy that applies to ALL users. It ensures
 * that even if a permissive policy passes, the case must be in the user's org.
 * For clients/contractors, the restrictive org check fails, so they rely on
 * the permissive client/contractor policies below.
 */
export const rlsCaseEventsStaff = pgPolicy("rls_case_events_staff", {
  as: "restrictive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
}).link(caseEvents);

/**
 * PERMISSIVE policy: Staff can access events on cases in their organization.
 *
 * This is the permissive counterpart to the restrictive staff policy.
 * Without this, staff would be denied because PostgreSQL requires ≥1 permissive pass.
 *
 * Staff: case → case.organization_id = their org → PASSES ✓
 * Client/Contractor: don't set org → doesn't match → doesn't affect them
 *
 * Added in: 0008_rls_permissive_staff_policies.sql
 */
export const rlsCaseEventsStaffAccess = pgPolicy("rls_case_events_staff_access", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
}).link(caseEvents);

/**
 * PERMISSIVE policy: Client can access events on cases they hired the firm for.
 *
 * Filters by: case_id → parent case → client_user_id = current user
 * Client: case.client_user_id = their user_id → PASSES ✓
 * Staff/Contractor: doesn't match → doesn't help
 */
export const rlsCaseEventsClient = pgPolicy("rls_case_events_client", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.client_user_id = ${currentUserId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.client_user_id = ${currentUserId}
  )`,
}).link(caseEvents);

/**
 * PERMISSIVE policy: Contractor can access events on cases they are assigned to.
 *
 * Filters by: case_id → case_assignments → user_id = current user
 * Contractor: in case_assignments for this case → PASSES ✓
 * Staff/Client: doesn't match → doesn't help
 */
export const rlsCaseEventsContractor = pgPolicy("rls_case_events_contractor", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT ca.case_id FROM case_assignments ca
    WHERE ca.user_id = ${currentUserId}
  )`,
  withCheck: sql`case_id IN (
    SELECT ca.case_id FROM case_assignments ca
    WHERE ca.user_id = ${currentUserId}
  )`,
}).link(caseEvents);


// =============================================================================
// case_record_notes table
// =============================================================================
// Case notes inherit access from their parent case, same logic as case_events.
// Currently a dead schema (no code writes to it), but policies are defined
// for when/if it's used in the future.

/**
 * RESTRICTIVE policy: Case notes must belong to a case in the current organization.
 *
 * Same pattern as case_events: subquery to parent case for org check.
 * Staff: passes ✓ | Client/Contractor: fails ✗
 */
export const rlsCaseRecordNotesStaff = pgPolicy("rls_case_record_notes_staff", {
  as: "restrictive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
}).link(caseRecordNotes);

/**
 * PERMISSIVE policy: Staff can access notes on cases in their organization.
 *
 * Permissive counterpart for staff. Required because PostgreSQL needs ≥1 permissive pass.
 *
 * Added in: 0008_rls_permissive_staff_policies.sql
 */
export const rlsCaseRecordNotesStaffAccess = pgPolicy("rls_case_record_notes_staff_access", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.organization_id = ${currentOrgId}
  )`,
}).link(caseRecordNotes);

/**
 * PERMISSIVE policy: Client can access notes on cases they hired the firm for.
 *
 * Same pattern as case_events client policy.
 */
export const rlsCaseRecordNotesClient = pgPolicy("rls_case_record_notes_client", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.client_user_id = ${currentUserId}
  )`,
  withCheck: sql`case_id IN (
    SELECT c.id FROM cases c WHERE c.client_user_id = ${currentUserId}
  )`,
}).link(caseRecordNotes);

/**
 * PERMISSIVE policy: Contractor can access notes on cases they are assigned to.
 *
 * Same pattern as case_events contractor policy.
 */
export const rlsCaseRecordNotesContractor = pgPolicy("rls_case_record_notes_contractor", {
  as: "permissive",
  for: "all",
  using: sql`case_id IN (
    SELECT ca.case_id FROM case_assignments ca
    WHERE ca.user_id = ${currentUserId}
  )`,
  withCheck: sql`case_id IN (
    SELECT ca.case_id FROM case_assignments ca
    WHERE ca.user_id = ${currentUserId}
  )`,
}).link(caseRecordNotes);


// =============================================================================
// clients table
// =============================================================================
// Clients represent the people who hire the firm. Two roles access this table:
//
//   Staff: see all clients in their firm (org-scoped)
//   Client: see only their own profile (user_id match)

/**
 * RESTRICTIVE policy: Clients must belong to the current organization.
 *
 * Baseline filter for all users.
 * Staff: passes (org matches) ✓
 * Client: fails (no org set) ✗ → relies on permissive self policy below
 */
export const rlsClientsOrg = pgPolicy("rls_clients_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(clients);

/**
 * PERMISSIVE policy: Staff can access all clients in their organization.
 *
 * Without this, staff would be denied (restrictive alone isn't enough).
 *
 * Added in: 0008_rls_permissive_staff_policies.sql
 */
export const rlsClientsStaff = pgPolicy("rls_clients_staff", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(clients);

/**
 * PERMISSIVE policy: Client can access their own profile only.
 *
 * Client sets app.current_user_id. This policy passes when:
 *   clients.user_id = get_current_user_id() → their own record ✓
 *
 * Staff: user_id doesn't match their auth user_id → doesn't help
 * Contractor: not a client → doesn't help
 */
export const rlsClientsSelf = pgPolicy("rls_clients_self", {
  as: "permissive",
  for: "all",
  using: sql`user_id = ${currentUserId}`,
  withCheck: sql`user_id = ${currentUserId}`,
}).link(clients);


// =============================================================================
// leads table
// =============================================================================
// Leads are potential cases in the intake pipeline. STAFF ONLY — clients and
// contractors never access leads. Only a restrictive org policy is needed.

/**
 * RESTRICTIVE policy: Leads must belong to the current organization.
 *
 * Staff only: organization_id = their org → passes ✓
 * Client/Contractor: no org set → fails, and no permissive policy exists → denied ✗
 *
 * No permissive policies are needed because clients/contractors should never
 * see leads. The restrictive policy alone is sufficient for staff access.
 */
export const rlsLeadsOrg = pgPolicy("rls_leads_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(leads);


// =============================================================================
// lead_events table
// =============================================================================
// Lead events are an append-only audit trail. Access is inherited from the
// parent lead. STAFF ONLY — no client/contractor access to leads.

/**
 * RESTRICTIVE policy: Lead events must belong to a lead in the current organization.
 *
 * Filters by: lead_id → parent lead → organization_id = current org
 * Staff: passes ✓ | Client/Contractor: fails, no permissive → denied ✗
 *
 * No permissive policies needed — staff-only table.
 */
export const rlsLeadEventsStaff = pgPolicy("rls_lead_events_staff", {
  as: "restrictive",
  for: "all",
  using: sql`lead_id IN (
    SELECT l.id FROM leads l WHERE l.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`lead_id IN (
    SELECT l.id FROM leads l WHERE l.organization_id = ${currentOrgId}
  )`,
}).link(leadEvents);


// =============================================================================
// lead_notes table
// =============================================================================
// Lead notes inherit access from their parent lead. STAFF ONLY.

/**
 * RESTRICTIVE policy: Lead notes must belong to a lead in the current organization.
 *
 * Filters by: lead_id → parent lead → organization_id = current org
 * Staff: passes ✓ | Client/Contractor: fails, no permissive → denied ✗
 *
 * No permissive policies needed — staff-only table.
 */
export const rlsLeadNotesStaff = pgPolicy("rls_lead_notes_staff", {
  as: "restrictive",
  for: "all",
  using: sql`lead_id IN (
    SELECT l.id FROM leads l WHERE l.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`lead_id IN (
    SELECT l.id FROM leads l WHERE l.organization_id = ${currentOrgId}
  )`,
}).link(leadNotes);
