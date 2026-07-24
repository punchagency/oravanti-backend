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
import { aiScanJobs } from "./ai-scan-jobs";
import {
  caseIssueDocuments,
  caseIssueEvents,
  caseIssues,
} from "./case-issues";
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


// =============================================================================
// case_issues table
// =============================================================================
// Staff only. The AI case-review dashboard is firm-internal: an issue names a
// document's shortcomings, so it must never reach the client or a contractor.
//
// PERMISSIVE, not restrictive. Restrictive policies are AND-ed with permissive
// ones, and a table whose only policy is restrictive matches nothing at all —
// Postgres defaults to deny when no permissive policy grants access. A
// staff-only table therefore needs its org rule to be the permissive grant.

export const rlsCaseIssuesOrg = pgPolicy("rls_case_issues_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(caseIssues);


// =============================================================================
// case_issue_documents table
// =============================================================================
// No organization column of its own — scope is inherited from the parent issue,
// the same way case_events inherits from cases. Adding an organization column
// here would duplicate (and could contradict) the parent's.

export const rlsCaseIssueDocumentsOrg = pgPolicy("rls_case_issue_documents_org", {
  as: "permissive",
  for: "all",
  using: sql`issue_id IN (
    SELECT i.id FROM case_issues i WHERE i.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`issue_id IN (
    SELECT i.id FROM case_issues i WHERE i.organization_id = ${currentOrgId}
  )`,
}).link(caseIssueDocuments);


// =============================================================================
// case_issue_events table
// =============================================================================
// Inherited from the parent issue, as above. This is the resolution log, so it
// is at least as sensitive as the issue itself.

export const rlsCaseIssueEventsOrg = pgPolicy("rls_case_issue_events_org", {
  as: "permissive",
  for: "all",
  using: sql`issue_id IN (
    SELECT i.id FROM case_issues i WHERE i.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`issue_id IN (
    SELECT i.id FROM case_issues i WHERE i.organization_id = ${currentOrgId}
  )`,
}).link(caseIssueEvents);


// =============================================================================
// ai_scan_jobs table
// =============================================================================
// Staff only. Job rows carry no document content, but they do reveal which
// scenarios a firm is scanning and when.

export const rlsAiScanJobsOrg = pgPolicy("rls_ai_scan_jobs_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(aiScanJobs);


// =============================================================================
// document_analyses / document_photo_comparisons — deliberately NOT covered
// =============================================================================
// These are content-addressed caches keyed on (checksum, prompt_version,
// model_version) with no organization column by design: an extraction is a pure
// function of the bytes, so identical bytes resolve to one row regardless of
// which firm uploaded them. There is nothing tenant-scoped to filter on, and
// adding a scope would defeat the cache. Reaching a row requires already
// knowing the checksum, which is only obtainable via a document the caller can
// already see.
