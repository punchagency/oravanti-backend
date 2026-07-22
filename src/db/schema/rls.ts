// =============================================================================
// Row-Level Security (RLS) Policy Definitions (Drizzle pgPolicy API)
// =============================================================================
// This file defines RLS policies using Drizzle's native pgPolicy API.
// When `drizzle-kit generate` runs, these policies are included in the migration.
//
// Strategy:
//   - Restrictive policies (AND logic): baseline filter for staff/firm_admin
//   - Permissive policies (OR logic): alternative access for clients/contractors
//
// Custom PostgreSQL functions required:
//   - get_current_organization_id() — reads app.current_organization_id session var
//   - get_current_user_id() — reads app.current_user_id session var
//
// These functions must exist in the database before policies are applied.
// See: drizzle/migrations/0006_rls_consolidated.sql (raw SQL reference)
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

const currentOrgId = sql`get_current_organization_id()`;
const currentUserId = sql`get_current_user_id()`;


// =============================================================================
// cases table
// =============================================================================
// Staff: see all org cases (restrictive)
// Client: see cases they hired the firm for (permissive)
// Contractor: see cases they're assigned to via case_assignments (permissive)

export const rlsCasesOrg = pgPolicy("rls_cases_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(cases);

export const rlsCasesClient = pgPolicy("rls_cases_client", {
  as: "permissive",
  for: "all",
  using: sql`client_user_id = ${currentUserId}`,
  withCheck: sql`client_user_id = ${currentUserId}`,
}).link(cases);

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
// Access inherited from parent case via subquery

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
// Access inherited from parent case via subquery

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
// Staff: all clients in their firm (handled by restrictive org policy in SQL migration)
// Client: their own profile only

export const rlsClientsOrg = pgPolicy("rls_clients_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(clients);

export const rlsClientsSelf = pgPolicy("rls_clients_self", {
  as: "permissive",
  for: "all",
  using: sql`user_id = ${currentUserId}`,
  withCheck: sql`user_id = ${currentUserId}`,
}).link(clients);


// =============================================================================
// leads table
// =============================================================================
// Staff only — no client/contractor access to leads

export const rlsLeadsOrg = pgPolicy("rls_leads_org", {
  as: "restrictive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(leads);


// =============================================================================
// lead_events table
// =============================================================================
// Access inherited from parent lead via subquery

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
// Access inherited from parent lead via subquery

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
