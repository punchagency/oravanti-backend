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
// This file holds the 19 tables whose policies are bespoke — each needed a
// different predicate for staff, clients and contractors, so each is written
// out by hand:
//
//   audit_events,
//   cases, case_record_notes, clients,
//   leads, lead_notes,
//   case_issues, case_issue_documents, ai_scan_jobs,
//   invoices, invoice_line_items, invoice_payments, invoice_instalments,
//   invoice_followups, invoice_deliveries, invoice_line_presets,
//   invoice_number_sequences, billing_rates, time_entries
//
// One of these — invoice_line_presets — holds shared rows with a NULL
// organization_id, so its read and write clauses are not the same expression.
// See the note above its policy.
//
// **Every other table lives in `rls-tenant.ts`**, which covers the remaining 67
// through org-scoped and parent-scoped factories and names the rest in an
// explicit `RLS_EXEMPTIONS` registry with a reason each.
// `__tests__/unit/db/rls-coverage.test.ts` fails if any table is in neither
// place, so a new table cannot ship unconsidered.
//
// Prerequisites:
//   - Custom PostgreSQL functions (get_current_organization_id, get_current_user_id)
//     must exist in the database before policies are applied.
//   - RLS must be ENABLED on each table. drizzle-kit does this automatically:
//     any table carrying a linked pgPolicy gets
//     `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` emitted into the
//     generated migration. Adding a pgPolicy block below is therefore
//     sufficient — no hand-written SQL step is required.
// =============================================================================

import { sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

// Import tables that need RLS policies
import {
  cases,
  caseRecordNotes,
} from "./cases";
import { auditEvents } from "./audit-events";
import { aiScanJobs } from "./ai-scan-jobs";
import {
  caseIssueDocuments,
  caseIssues,
} from "./case-issues";
import { billingRates } from "./billing-rates";
import { clients } from "./clients";
import { invoiceDeliveries } from "./invoice-deliveries";
import { invoiceFollowups } from "./invoice-followups";
import { invoiceLinePresets } from "./invoice-line-presets";
import { invoiceNumberSequences } from "./invoice-number-sequences";
import { invoiceInstalments } from "./invoice-instalments";
import { confidoFirms } from "./confido-firms";
import { invoicePayments } from "./invoice-payments";
import { invoices, invoiceLineItems } from "./invoices";
import { leads, leadNotes } from "./leads";
import { timeEntries } from "./time-entries";

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

/**
 * PERMISSIVE counterpart. Without it this table returns nothing at all.
 *
 * The comment above used to say a restrictive policy alone was sufficient for
 * staff. It is not, and the header of this file says why: the rule is
 * `(≥1 permissive passes) AND (all restrictive pass)`. With **zero** permissive
 * policies the first half is false for every row, so an RLS-bound connection
 * sees an empty table.
 *
 * It has never bitten because RLS is inert on the connection the app uses —
 * `oravanti_admin` owns these tables and they were not `FORCE`d. Both halves of
 * that are removed by `scripts/apply-security-baseline.ts`, which is exactly
 * when this policy stops being theoretical.
 */
export const rlsLeadsStaff = pgPolicy("rls_leads_staff", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(leads);


// =============================================================================
// lead_events table


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

/**
 * PERMISSIVE counterpart — see the note on `rlsLeadsStaff`.
 *
 * Same predicate as the restrictive policy above, deliberately. The restrictive
 * one is the baseline every role must satisfy; this one is what makes any row
 * visible in the first place. A staff-only table still needs both.
 */
export const rlsLeadNotesStaffAccess = pgPolicy("rls_lead_notes_staff_access", {
  as: "permissive",
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
// Finance tables
// =============================================================================
// invoices, invoice_line_items, invoice_payments, invoice_instalments,
// invoice_followups, invoice_line_presets, finance_events, billing_rates,
// time_entries
//
// Staff only. Billing is firm-internal: an invoice names what the firm charged
// and what a client still owes, and the trust lines carry client money the firm
// merely holds. Clients and contractors get no permissive grant here, so they
// are denied outright. (A client-portal invoice view would need its own
// permissive `client_user_id = get_current_user_id()` policy plus a restrictive
// org policy — the cases pattern above. Deliberately not added: nothing in the
// finance module serves clients today, and a half-open door is worse than none.)
//
// PERMISSIVE, not restrictive — see the case_issues note above for why a
// staff-only table whose only policy is restrictive matches nothing at all.
//
// Every one of these tables carries its own organization_id, deliberately, so
// each policy is a column comparison rather than the subquery case_events
// needs. On the two child tables (line items, payments) that is one
// denormalized value bought in exchange for an index-friendly policy on
// precisely the tables the aggregate queries scan hardest.

export const rlsInvoicesOrg = pgPolicy("rls_invoices_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(invoices);

export const rlsInvoiceLineItemsOrg = pgPolicy("rls_invoice_line_items_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(invoiceLineItems);

export const rlsInvoicePaymentsOrg = pgPolicy("rls_invoice_payments_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(invoicePayments);

export const rlsInvoiceInstalmentsOrg = pgPolicy(
  "rls_invoice_instalments_org",
  {
    as: "permissive",
    for: "all",
    using: sql`organization_id = ${currentOrgId}`,
    withCheck: sql`organization_id = ${currentOrgId}`,
  },
).link(invoiceInstalments);

/**
 * Only a counter, but the count is how many invoices a firm has issued this
 * year — business-sensitive on its own, and the allocation path writes to it,
 * so leaving it open would let one tenant bump another's sequence.
 */
export const rlsInvoiceNumberSequencesOrg = pgPolicy(
  "rls_invoice_number_sequences_org",
  {
    as: "permissive",
    for: "all",
    using: sql`organization_id = ${currentOrgId}`,
    withCheck: sql`organization_id = ${currentOrgId}`,
  },
).link(invoiceNumberSequences);

export const rlsInvoiceFollowupsOrg = pgPolicy("rls_invoice_followups_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(invoiceFollowups);

export const rlsInvoiceDeliveriesOrg = pgPolicy("rls_invoice_deliveries_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(invoiceDeliveries);


/**
 * The one policy in this file whose `using` and `withCheck` deliberately
 * differ, and the asymmetry IS the design.
 *
 * `invoice_line_presets` holds two tiers in one table: rows with a NULL
 * organization_id ship with the product and belong to every firm, rows with
 * one belong to the firm that saved them.
 *
 *   - **Read** admits NULL, so every firm sees the shipped catalog.
 *   - **Write** does not, so no firm can author, edit or delete a shipped row —
 *     the only way to override one is to insert a firm-owned row that shadows
 *     it, which is a write to a row the firm does own.
 *
 * Note this means a NULL-org row is invisible to nobody and writable by
 * nobody through the API. The CLI seeds them outside request context, where no
 * `app.current_organization_id` is set at all.
 *
 * Do NOT "tidy" this into the matching pair every other policy here uses:
 * making `withCheck` admit NULL would let any firm mint rows for every other
 * firm, and making `using` reject it would hide the catalog from all of them.
 */
export const rlsInvoiceLinePresetsOrg = pgPolicy(
  "rls_invoice_line_presets_org",
  {
    as: "permissive",
    for: "all",
    using: sql`organization_id IS NULL OR organization_id = ${currentOrgId}`,
    withCheck: sql`organization_id = ${currentOrgId}`,
  },
).link(invoiceLinePresets);

/**
 * Billing rates are what every staff member's earnings are computed from, so
 * they are at least as sensitive as the invoices themselves.
 */
export const rlsBillingRatesOrg = pgPolicy("rls_billing_rates_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(billingRates);

/**
 * time_entries had no policy before the finance module existed — it was
 * reachable only through revenue-analytics, but it was never actually isolated.
 * Covering it now closes that gap.
 */
export const rlsTimeEntriesOrg = pgPolicy("rls_time_entries_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(timeEntries);

/**
 * confido_firms — one firm's merchant account.
 *
 * The row holds an encrypted, unscoped, full-access credential for moving that
 * firm's money, so tenant isolation here is not merely about privacy.
 *
 * Note this policy protects the authenticated path only. The webhook route and
 * its worker have no request context, so `db` falls back to `systemDb` and RLS
 * does not apply to them at all — they must carry an explicit organization
 * predicate resolved from confido_firm_id. Same discipline as
 * payment-webhooks.service, and the reason confido_firm_id is uniquely indexed.
 */
export const rlsConfidoFirmsOrg = pgPolicy("rls_confido_firms_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(confidoFirms);


// =============================================================================
// audit_events
// =============================================================================
// The audit trail is firm-internal and staff-only. It names who did what to
// whose matter, so it is at least as sensitive as every table it describes —
// and it aggregates them, which makes it more so. Clients and contractors get
// no permissive grant here and are therefore denied outright. A client-portal
// "activity on my matter" view would need its own permissive policy scoped to
// that client's own entities, not a relaxation of these.
//
// ─── Two things these policies deliberately do NOT do ───────────────────────
//
// 1. They do not make the tables immutable. RLS filters which rows a role can
//    reach; it cannot express "INSERT and SELECT but never UPDATE or DELETE".
//    That is a grant, and it lands in Phase 7 with the `oravanti_app` role.
//    Until then, append-only is enforced by there being no code that updates
//    or deletes these tables, and by no route exposing a path that would.
//
// 2. They do not cover rows with a NULL organization_id. Those are the
//    platform-level security records — a failed sign-in has an email and an IP
//    and nothing else, because the org is not known until authentication
//    succeeds. `organization_id = get_current_organization_id()` is NULL =
//    NULL, which is false, so a tenant connection can neither read nor write
//    them. That is the intent: they belong to the security feed and to
//    alerting, both of which read through `systemDb`, and they must not appear
//    in any firm's audit view.

export const rlsAuditEventsOrg = pgPolicy("rls_audit_events_org", {
  as: "permissive",
  for: "all",
  using: sql`organization_id = ${currentOrgId}`,
  withCheck: sql`organization_id = ${currentOrgId}`,
}).link(auditEvents);


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
