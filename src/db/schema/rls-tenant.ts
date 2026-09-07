// =============================================================================
// Row-Level Security — tenant coverage for the remaining tables
// =============================================================================
// `rls.ts` covers the 19 tables that were hand-written first, each with bespoke
// staff/client/contractor policies because each needed a different predicate.
// This file covers **everything else**, and it exists because the answer to
// "which tables have RLS?" was previously "the ones somebody got to", with no
// way to tell an intentional omission from a forgotten one.
//
// Here every remaining table is in exactly one of three lists:
//
//   1. `orgScoped`     — has `organization_id`; filtered on it directly.
//   2. `parentScoped`  — no org column; filtered through the parent that has one.
//   3. `RLS_EXEMPTIONS` — deliberately unprotected, each with a stated reason.
//
// `scripts/apply-security-baseline.ts` and
// `__tests__/unit/db/rls-coverage.test.ts` both assert that those three lists
// account for every table in the schema. **A new table therefore fails CI
// until someone decides which list it belongs in**, which is the property this
// file is really for — the policies are the easy part.
//
// ─── Why every table gets both a restrictive and a permissive policy ────────
//
// Postgres evaluates `(≥1 permissive passes) AND (all restrictive pass)`. A
// table with RLS enabled and *only* restrictive policies denies every row, and
// a table with only a permissive policy is fine until a second permissive
// policy is added later and silently widens access by OR. Writing the pair
// makes the baseline explicit and makes later additions safe by construction.
//
// ─── Client and contractor access ───────────────────────────────────────────
//
// Deliberately absent here. Clients and contractors reach data through the
// narrow set of tables in `rls.ts` (cases, documents they are granted, their
// own invoices) and nothing in this file. Under these policies a connection
// that sets only `app.current_user_id` sees nothing from these tables, which is
// the intended answer — not an oversight. Widening that is a per-table decision
// with a per-table predicate, and belongs next to the bespoke policies.
// =============================================================================

import { sql } from "drizzle-orm";
import { pgPolicy, type PgTable } from "drizzle-orm/pg-core";

import { adminSessions } from "./admin-sessions";
import { admins } from "./admins";
import { adverseParties } from "./adverse-parties";
import { aiSystemConfig } from "./ai-system-config";
import { assignments } from "./assignments";
import { calendarEvents } from "./calendar-events";
import { caseMilestones } from "./case-milestones";
import { caseForms } from "./case-forms";
import {
  caseFormCorrectionComments,
  caseFormCorrections,
} from "./case-form-corrections";
import {
  caseFormFieldRevisions,
  caseFormFieldValues,
  caseFormVersions,
} from "./form-fields";
import {
  caseAssignments,
  casesToCertifications,
  certifications,
} from "./cases";
import { clientCompanies } from "./client-companies";
import { clientContacts } from "./client-contacts";
import { clientRequests } from "./client-requests";
import { clientNotes, clientsToTeams } from "./clients";
import { companies } from "./companies";
import { conflictChecks } from "./conflict-checks";
import { consultationLocations } from "./consultation-locations";
import { consultationSettings } from "./consultation-settings";
import { consultationParticipants, consultations } from "./consultations";
import {
  caseTypeDocumentRequirements,
  scenarioDocumentRequirements,
} from "./document-requirements";
import {
  documentAccess,
  documentCaseLinks,
  documentRequests,
  documentVersions,
  documents,
  externalSubmissions,
} from "./documents";
import { connectedEmailAccount } from "./email";
import { feeAgreements } from "./fee-agreements";
import { financialAccessControls } from "./financial-access-controls";
import { firmPracticeAreas } from "./firm-practice-areas";
import {
  intakePipelineTemplateSteps,
  intakePipelineTemplates,
} from "./intake-pipeline-templates";
import { leadDocumentLinks } from "./lead-document-links";
import { leaveRequests } from "./leave-requests";
import { immigrationCaseDetails } from "./immigration-case-details";
import { personalInjuryCaseDetails } from "./personal-injury-case-details";
import { paralegalProfiles } from "./paralegal-profiles";
import { profiles } from "./profiles";
import { roleAppearance } from "./role-appearance";
import { roleGroup, roleGroupMember } from "./role-groups";
import {
  questionnaireAnswerRevisions,
  questionnaireAnswers,
  questionnaireResponseFiles,
  questionnaireResponses,
  questionnaireResponseVersions,
  questionnaireSends,
} from "./questionnaires";
import {
  staffAvailability,
  staffAvailabilityBreaks,
  staffAvailabilityOverrides,
} from "./staff-availability";
import { staffCertifications } from "./staff-certifications";
import { staffPracticeAreaCaseTypes } from "./staff-practice-area-case-types";
import { staff } from "./staff";
import { subscriptions } from "./subscriptions";
import { tasks } from "./tasks";
import { teamMembers } from "./team-members";
import { teamPracticeAreaCaseTypes } from "./team-practice-area-case-types";
import { caseNotes, workflowModuleActivations } from "./workflow";

const currentOrgId = sql`get_current_organization_id()`;
const currentUserId = sql`get_current_user_id()`;

/**
 * The restrictive + permissive pair for a table that carries `organization_id`.
 *
 * `withCheck` mirrors `using` on purpose: without it a tenant could `INSERT` or
 * `UPDATE` a row **into another organization** and then be unable to see what
 * they had just written. Reads and writes are filtered by the same expression
 * everywhere in this file.
 */
const orgScoped = (name: string, table: PgTable) => [
  pgPolicy(`rls_${name}_org`, {
    as: "restrictive",
    for: "all",
    using: sql`organization_id = ${currentOrgId}`,
    withCheck: sql`organization_id = ${currentOrgId}`,
  }).link(table),
  pgPolicy(`rls_${name}_staff`, {
    as: "permissive",
    for: "all",
    using: sql`organization_id = ${currentOrgId}`,
    withCheck: sql`organization_id = ${currentOrgId}`,
  }).link(table),
];

/**
 * The same pair for a table reached through a parent that carries the org.
 *
 * `column` is this table's foreign key; `parentTable`/`parentColumn` name the
 * row it points at. The generated predicate is an `IN (SELECT …)` rather than a
 * join, so it composes with whatever the query already does.
 *
 * The parent must itself be org-scoped, or this filters on nothing — that is
 * checked by `__tests__/unit/db/rls-coverage.test.ts`, not left to review.
 */
const parentScoped = (
  name: string,
  table: PgTable,
  column: string,
  parentTable: string,
  parentColumn = "id",
) => {
  const predicate = sql.raw(
    `${column} IN (SELECT p.${parentColumn} FROM ${parentTable} p WHERE p.organization_id = get_current_organization_id())`,
  );

  return [
    pgPolicy(`rls_${name}_org`, {
      as: "restrictive",
      for: "all",
      using: predicate,
      withCheck: predicate,
    }).link(table),
    pgPolicy(`rls_${name}_staff`, {
      as: "permissive",
      for: "all",
      using: predicate,
      withCheck: predicate,
    }).link(table),
  ];
};

// ─────────────────────────────────────────────────────────────────────────────
// Org-scoped tables
// ─────────────────────────────────────────────────────────────────────────────

export const [rlsAdminSessionsOrg, rlsAdminSessionsStaff] = orgScoped(
  "admin_sessions",
  adminSessions,
);
export const [rlsAdminsOrg, rlsAdminsStaff] = orgScoped("admins", admins);
export const [rlsAdversePartiesOrg, rlsAdversePartiesStaff] = orgScoped(
  "adverse_parties",
  adverseParties,
);
export const [rlsAiSystemConfigOrg, rlsAiSystemConfigStaff] = orgScoped(
  "ai_system_config",
  aiSystemConfig,
);
export const [rlsAssignmentsOrg, rlsAssignmentsStaff] = orgScoped(
  "assignments",
  assignments,
);
export const [rlsCalendarEventsOrg, rlsCalendarEventsStaff] = orgScoped(
  "calendar_events",
  calendarEvents,
);
export const [rlsCaseMilestonesOrg, rlsCaseMilestonesStaff] = orgScoped(
  "case_milestones",
  caseMilestones,
);
export const [rlsCaseFormsOrg, rlsCaseFormsStaff] = orgScoped(
  "case_forms",
  caseForms,
);
export const [rlsCaseFormFieldValuesOrg, rlsCaseFormFieldValuesStaff] =
  orgScoped("case_form_field_values", caseFormFieldValues);
// Form value history. Firm data like the values themselves — no rows with a
// NULL organization exist in either table, so plain org scoping fits.
export const [rlsCaseFormVersionsOrg, rlsCaseFormVersionsStaff] = orgScoped(
  "case_form_versions",
  caseFormVersions,
);
export const [rlsCaseFormFieldRevisionsOrg, rlsCaseFormFieldRevisionsStaff] =
  orgScoped("case_form_field_revisions", caseFormFieldRevisions);
// The attorney's marks on a filing package. Carries its own organization_id
// for the same reason the values do: the Forms tab reads every mark on the
// matter in one query, and going through the form to find the firm would make
// that read a join on every page.
export const [rlsCaseFormCorrectionsOrg, rlsCaseFormCorrectionsStaff] =
  orgScoped("case_form_corrections", caseFormCorrections);

export const [rlsCertificationsOrg, rlsCertificationsStaff] = orgScoped(
  "certifications",
  certifications,
);
export const [rlsClientCompaniesOrg, rlsClientCompaniesStaff] = orgScoped(
  "client_companies",
  clientCompanies,
);
export const [rlsClientContactsOrg, rlsClientContactsStaff] = orgScoped(
  "client_contacts",
  clientContacts,
);
export const [rlsClientRequestsOrg, rlsClientRequestsStaff] = orgScoped(
  "client_requests",
  clientRequests,
);
export const [rlsCompaniesOrg, rlsCompaniesStaff] = orgScoped(
  "companies",
  companies,
);
export const [rlsConflictChecksOrg, rlsConflictChecksStaff] = orgScoped(
  "conflict_checks",
  conflictChecks,
);
export const [rlsConsultationLocationsOrg, rlsConsultationLocationsStaff] =
  orgScoped("consultation_locations", consultationLocations);
export const [rlsConsultationSettingsOrg, rlsConsultationSettingsStaff] =
  orgScoped("consultation_settings", consultationSettings);
export const [rlsConsultationsOrg, rlsConsultationsStaff] = orgScoped(
  "consultations",
  consultations,
);
export const [
  rlsConsultationParticipantsOrg,
  rlsConsultationParticipantsStaff,
] = orgScoped("consultation_participants", consultationParticipants);
export const [
  rlsCaseTypeDocumentRequirementsOrg,
  rlsCaseTypeDocumentRequirementsStaff,
] = orgScoped("case_type_document_requirements", caseTypeDocumentRequirements);
export const [
  rlsScenarioDocumentRequirementsOrg,
  rlsScenarioDocumentRequirementsStaff,
] = orgScoped("scenario_document_requirements", scenarioDocumentRequirements);
export const [rlsDocumentRequestsOrg, rlsDocumentRequestsStaff] = orgScoped(
  "document_requests",
  documentRequests,
);
export const [rlsConnectedEmailAccountOrg, rlsConnectedEmailAccountStaff] =
  orgScoped("connected_email_account", connectedEmailAccount);
export const [rlsFeeAgreementsOrg, rlsFeeAgreementsStaff] = orgScoped(
  "fee_agreements",
  feeAgreements,
);
export const [rlsFinancialAccessControlsOrg, rlsFinancialAccessControlsStaff] =
  orgScoped("financial_access_controls", financialAccessControls);
export const [rlsFirmPracticeAreasOrg, rlsFirmPracticeAreasStaff] = orgScoped(
  "firm_practice_areas",
  firmPracticeAreas,
);
export const [rlsIntakePipelineTemplatesOrg, rlsIntakePipelineTemplatesStaff] =
  orgScoped("intake_pipeline_templates", intakePipelineTemplates);
export const [rlsLeaveRequestsOrg, rlsLeaveRequestsStaff] = orgScoped(
  "leave_requests",
  leaveRequests,
);
export const [rlsImmigrationCaseDetailsOrg, rlsImmigrationCaseDetailsStaff] =
  orgScoped("immigration_case_details", immigrationCaseDetails);
export const [
  rlsPersonalInjuryCaseDetailsOrg,
  rlsPersonalInjuryCaseDetailsStaff,
] = orgScoped("personal_injury_case_details", personalInjuryCaseDetails);
export const [rlsParalegalProfilesOrg, rlsParalegalProfilesStaff] = orgScoped(
  "paralegal_profiles",
  paralegalProfiles,
);
export const [rlsRoleAppearanceOrg, rlsRoleAppearanceStaff] = orgScoped(
  "role_appearance",
  roleAppearance,
);
export const [rlsRoleGroupOrg, rlsRoleGroupStaff] = orgScoped(
  "role_group",
  roleGroup,
);
// questionnaire_sections / questionnaire_questions / questionnaire_logic_rules
// are NOT here: their organization_id is nullable (NULL = the platform's own
// system-scope rows), which `orgScoped`'s strict equality can never match. They
// take the asymmetric read-NULL/write-owned policy in rls.ts instead — the same
// one `invoice_line_presets` and `workflow_templates` use.
export const [rlsQuestionnaireSendsOrg, rlsQuestionnaireSendsStaff] = orgScoped(
  "questionnaire_sends",
  questionnaireSends,
);
export const [rlsQuestionnaireResponsesOrg, rlsQuestionnaireResponsesStaff] =
  orgScoped("questionnaire_responses", questionnaireResponses);
export const [rlsQuestionnaireAnswersOrg, rlsQuestionnaireAnswersStaff] =
  orgScoped("questionnaire_answers", questionnaireAnswers);
// Answer history. Firm data like the answers themselves, so the same plain
// org scoping applies — no NULL-organization rows exist in either table.
export const [
  rlsQuestionnaireResponseVersionsOrg,
  rlsQuestionnaireResponseVersionsStaff,
] = orgScoped("questionnaire_response_versions", questionnaireResponseVersions);
export const [
  rlsQuestionnaireAnswerRevisionsOrg,
  rlsQuestionnaireAnswerRevisionsStaff,
] = orgScoped("questionnaire_answer_revisions", questionnaireAnswerRevisions);
export const [
  rlsQuestionnaireResponseFilesOrg,
  rlsQuestionnaireResponseFilesStaff,
] = orgScoped("questionnaire_response_files", questionnaireResponseFiles);
export const [rlsStaffAvailabilityOrg, rlsStaffAvailabilityStaff] = orgScoped(
  "staff_availability",
  staffAvailability,
);
export const [rlsStaffAvailabilityBreaksOrg, rlsStaffAvailabilityBreaksStaff] =
  orgScoped("staff_availability_breaks", staffAvailabilityBreaks);
export const [
  rlsStaffAvailabilityOverridesOrg,
  rlsStaffAvailabilityOverridesStaff,
] = orgScoped("staff_availability_overrides", staffAvailabilityOverrides);
export const [rlsStaffOrg, rlsStaffStaff] = orgScoped("staff", staff);
export const [rlsSubscriptionsOrg, rlsSubscriptionsStaff] = orgScoped(
  "subscriptions",
  subscriptions,
);
export const [rlsTasksOrg, rlsTasksStaff] = orgScoped("tasks", tasks);
export const [rlsCaseNotesOrg, rlsCaseNotesStaff] = orgScoped(
  "case_notes",
  caseNotes,
);
// Unlike the three template tables above, this one is per-matter and carries a
// NOT NULL organization_id, so the generic factory fits with no caveat.
export const [
  rlsWorkflowModuleActivationsOrg,
  rlsWorkflowModuleActivationsStaff,
] = orgScoped("workflow_module_activations", workflowModuleActivations);

// ─────────────────────────────────────────────────────────────────────────────
// Parent-scoped tables
// ─────────────────────────────────────────────────────────────────────────────

// A correction's thread. No organization of its own — a comment belongs to the
// mark, and a mark that is not the firm's has no comments the firm may read.
export const [
  rlsCaseFormCorrectionCommentsOrg,
  rlsCaseFormCorrectionCommentsStaff,
] = parentScoped(
  "case_form_correction_comments",
  caseFormCorrectionComments,
  "correction_id",
  "case_form_corrections",
);
export const [rlsCasesToCertificationsOrg, rlsCasesToCertificationsStaff] =
  parentScoped(
    "cases_to_certifications",
    casesToCertifications,
    "case_id",
    "cases",
  );
export const [rlsCaseAssignmentsOrg, rlsCaseAssignmentsStaff] = parentScoped(
  "case_assignments",
  caseAssignments,
  "case_id",
  "cases",
);
export const [rlsClientNotesOrg, rlsClientNotesStaff] = parentScoped(
  "client_notes",
  clientNotes,
  "client_id",
  "clients",
);
export const [rlsClientsToTeamsOrg, rlsClientsToTeamsStaff] = parentScoped(
  "clients_to_teams",
  clientsToTeams,
  "client_id",
  "clients",
);
export const [
  rlsIntakePipelineTemplateStepsOrg,
  rlsIntakePipelineTemplateStepsStaff,
] = parentScoped(
  "intake_pipeline_template_steps",
  intakePipelineTemplateSteps,
  "template_id",
  "intake_pipeline_templates",
);
export const [rlsLeadDocumentLinksOrg, rlsLeadDocumentLinksStaff] =
  parentScoped("lead_document_links", leadDocumentLinks, "lead_id", "leads");
export const [rlsStaffCertificationsOrg, rlsStaffCertificationsStaff] =
  parentScoped(
    "staff_certifications",
    staffCertifications,
    "staff_id",
    "staff",
  );
export const [
  rlsStaffPracticeAreaCaseTypesOrg,
  rlsStaffPracticeAreaCaseTypesStaff,
] = parentScoped(
  "staff_practice_area_case_types",
  staffPracticeAreaCaseTypes,
  "staff_id",
  "staff",
);
export const [rlsExternalSubmissionsOrg, rlsExternalSubmissionsStaff] =
  parentScoped(
    "external_submissions",
    externalSubmissions,
    "request_id",
    "document_requests",
  );
export const [rlsRoleGroupMemberOrg, rlsRoleGroupMemberStaff] = parentScoped(
  "role_group_member",
  roleGroupMember,
  "group_id",
  "role_group",
);

// `team` and `team_member` are better-auth tables (see the exemptions below),
// but `team` does carry `organization_id`, so these two join through it.
export const [rlsTeamMembersOrg, rlsTeamMembersStaff] = parentScoped(
  "team_members",
  teamMembers,
  "team_id",
  "team",
);
export const [
  rlsTeamPracticeAreaCaseTypesOrg,
  rlsTeamPracticeAreaCaseTypesStaff,
] = parentScoped(
  "team_practice_area_case_types",
  teamPracticeAreaCaseTypes,
  "team_id",
  "team",
);

/**
 * `documents` has no organization column and is shared by leads and matters.
 *
 * Reachability, not ownership, is what makes a document a firm's: it belongs to
 * this org if it is linked to one of its matters, one of its leads, or one of
 * its document requests. Written as three `EXISTS` clauses rather than a
 * three-way `OR` over `IN (…)` so each can short-circuit on its own index.
 *
 * `created_by_user_id` is deliberately **not** one of the clauses. It would
 * make an orphaned upload visible to whoever performed it regardless of which
 * firm they now belong to, which is the opposite of tenancy.
 */
/*
  The third clause reaches a document through `external_submissions`, not
  through `document_requests` directly. A request is an ASK for a document and
  carries no `document_id`; the upload that answers it is the submission row,
  and that is what holds the link.

  Keep comments OUT of the template string. Drizzle emits it onto a single line,
  so a `--` comment silently swallows the rest of the policy.
*/
const documentVisibleSql = (documentIdExpr: string) => `(
  EXISTS (
    SELECT 1 FROM document_case_links dcl
    JOIN cases c ON c.id = dcl.case_id
    WHERE dcl.document_id = ${documentIdExpr}
      AND c.organization_id = get_current_organization_id()
  )
  OR EXISTS (
    SELECT 1 FROM lead_document_links ldl
    JOIN leads l ON l.id = ldl.lead_id
    WHERE ldl.document_id = ${documentIdExpr}
      AND l.organization_id = get_current_organization_id()
  )
  OR EXISTS (
    SELECT 1 FROM external_submissions es
    JOIN document_requests dr ON dr.id = es.request_id
    WHERE es.document_id = ${documentIdExpr}
      AND dr.organization_id = get_current_organization_id()
  )
)`;

const documentVisible = sql.raw(documentVisibleSql("documents.id"));

/**
 * Reads are filtered by reachability; **writes are not**.
 *
 * A document is inserted before anything links it to a matter, so a
 * `withCheck` using the same predicate would reject every upload — the links
 * do not exist yet at insert time. The row is unreachable to every other
 * tenant the moment it lands, and reachable to this one only once linked, so
 * the read filter is where the tenancy actually lives.
 */
export const rlsDocumentsOrg = pgPolicy("rls_documents_org", {
  as: "restrictive",
  for: "select",
  using: documentVisible,
}).link(documents);

export const rlsDocumentsStaff = pgPolicy("rls_documents_staff", {
  as: "permissive",
  for: "all",
  using: documentVisible,
}).link(documents);

/**
 * Everything hanging off a document inherits that document's reachability.
 *
 * The predicate is rebuilt from `documentVisibleSql` against the subquery's
 * alias rather than textually rewritten, so the three reachability clauses have
 * exactly one definition.
 */
const throughDocument = (name: string, table: PgTable) => {
  const predicate = sql.raw(
    `document_id IN (SELECT d.id FROM documents d WHERE ${documentVisibleSql("d.id")})`,
  );

  return [
    pgPolicy(`rls_${name}_org`, {
      as: "restrictive",
      for: "all",
      using: predicate,
      withCheck: predicate,
    }).link(table),
    pgPolicy(`rls_${name}_staff`, {
      as: "permissive",
      for: "all",
      using: predicate,
      withCheck: predicate,
    }).link(table),
  ];
};

export const [rlsDocumentVersionsOrg, rlsDocumentVersionsStaff] =
  throughDocument("document_versions", documentVersions);
export const [rlsDocumentCaseLinksOrg, rlsDocumentCaseLinksStaff] =
  throughDocument("document_case_links", documentCaseLinks);
export const [rlsDocumentAccessOrg, rlsDocumentAccessStaff] = throughDocument(
  "document_access",
  documentAccess,
);

/**
 * `profiles` is keyed on the user, not the firm — one row per person, and a
 * person can belong to more than one firm over time. Scoped to the caller
 * rather than the org, with the staff-directory read handled by `staff`.
 */
export const rlsProfilesSelf = pgPolicy("rls_profiles_self", {
  as: "permissive",
  for: "all",
  using: sql`user_id = ${currentUserId} OR user_id IN (
    SELECT s.user_id FROM staff s WHERE s.organization_id = ${currentOrgId}
  )`,
  withCheck: sql`user_id = ${currentUserId}`,
}).link(profiles);

// ─────────────────────────────────────────────────────────────────────────────
// Deliberate exemptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tables with no RLS, and why.
 *
 * This is the half of the coverage story that is normally missing. Consulted by
 * `__tests__/unit/db/rls-coverage.test.ts` and by
 * `scripts/apply-security-baseline.ts`, both of which fail on a table that is
 * neither covered nor listed here — so "we forgot" and "we decided not to"
 * cannot look the same again.
 */
export const RLS_EXEMPTIONS: Record<string, string> = {
  // ── better-auth internals ────────────────────────────────────────────────
  // Better Auth owns the shape and the queries. More importantly, session and
  // user are read *during* authentication — before any org or user setting has
  // been applied to the connection — so an org-scoped policy on them would
  // deny the lookup that establishes the org and lock every account out.
  user: "better-auth owns it; read before any tenant context exists",
  session: "better-auth owns it; read before any tenant context exists",
  account: "better-auth owns it; holds provider credentials, never tenant data",
  verification: "better-auth owns it; short-lived tokens, no tenant data",
  two_factor: "better-auth owns it; keyed on user, read during authentication",
  organization:
    "the tenant list itself; membership is what scopes everything else",
  member: "better-auth organization membership; read to resolve the active org",
  invitation: "better-auth invitations; accepted before the invitee has an org",
  team: "better-auth teams; scoped through member, and joined by team_members",
  team_member: "better-auth team membership; the app uses team_members instead",
  organization_role:
    "better-auth dynamicAccessControl custom-role storage; scoped by organizationId inside better-auth's own adapter queries, read by role-CRUD endpoints before app-level tenant context is established",

  // ── The platform operator tier ───────────────────────────────────────────
  //
  // Oravanti's own staff. There is no tenant to scope this by — that is the
  // point of the table, not an omission — and it is read by
  // `requirePlatformAdmin` to decide whether a request may touch the platform
  // catalogue at all, which is before any tenant context could exist. Same
  // category as `user` and `session` above: identity, not firm data.
  platform_admins:
    "the platform operator list itself; has no tenant to be scoped to",

  // ── Global reference data, shared by every firm ──────────────────────────
  practice_areas: "global taxonomy, identical for every firm",
  practice_area_case_types: "global taxonomy, identical for every firm",
  practice_area_subcategories: "global taxonomy, identical for every firm",
  // Which forms a case type files. Global for the same reason the form
  // catalogue it points into is: an adjustment package is a fact about USCIS,
  // not a preference a firm holds. Written only by platform admins, and a firm
  // that needs a form this does not list adds it to the one matter instead.
  case_type_forms:
    "global reference data: the filing package a case type files; written only by platform admins",
  questionnaires: "platform-authored template, not firm data",
  // USCIS-published reference data (mandamus candidacy denominator) — global,
  // platform-maintained, identical for every firm. See uscis-processing-time-reference.ts.
  uscis_processing_time_reference:
    "global reference data, identical for every firm",
  // USCIS form-edition register — which edition of a form is acceptable on a
  // given filing date. Global, platform-maintained, identical for every firm,
  // same category as uscis_processing_time_reference above. See form-editions.ts.
  form_editions: "global reference data, identical for every firm",
  // Which question fills which form field, where the shared `fieldKey`
  // vocabulary does not already answer it. Moved here from `orgScoped` when
  // the form catalogue became the platform's: the table no longer has an
  // `organization_id` to scope by, because a mapping is no longer a firm's to
  // make. Same guard as the row below.
  form_field_mappings:
    "global reference data: which question fills a form field; written only by platform admins",
  // A form's parts, as far as they are more than a name its fields share: the
  // description, and the existence of a part that has no fields yet. Same
  // category as the mappings above and for both halves of the same reason —
  // there is no tenant to scope a USCIS form's divisions by, and it is
  // writable only through `/platform`, behind `requirePlatformAdmin`.
  form_parts:
    "global reference data: a form's own parts and what they are for; written only by platform admins",
  // What kind of work a form is *for*, as picked when the form is named. A
  // classification rather than a filing package: it is read beside
  // `case_type_forms` on the Forms list so a form shows under its area from the
  // moment it exists, rather than only once some matter type files it. Same
  // category as the two rows above — there is no tenant to scope a USCIS blank's
  // subject matter by, and it is written only through `/platform`, behind
  // `requirePlatformAdmin`.
  form_practice_areas:
    "global reference data: which practice areas a form is for; written only by platform admins",
  // The global vocabulary: one row per datum the system knows about a matter,
  // seeded from lib/schema/global-schema.ts. Not tenant-scoped for the same
  // reason `form_editions` is not — there is nothing firm-specific about what a
  // date of birth is. A firm extends the *questionnaire*, not the vocabulary: a
  // firm question that asks something this table does not name simply binds to
  // no node. Written only by the seed, which runs as a platform admin.
  schema_nodes:
    "global reference data: the datum vocabulary every firm shares; written only by the seed",
  // Which box on a USCIS blank a field key prints into. A property of the
  // published PDF, so identical for every firm — but note that "no tenant to
  // scope by" is only half of why this is safe. The other half is that it is
  // now writable *only* through `/platform`, behind `requirePlatformAdmin`.
  // Until that guard existed this table was reachable with `cases:update`, so
  // any firm staffer editing a matter could repoint a box on the I-485 for
  // every firm in the deployment. An exemption is a statement about who can
  // write, not only about who can read.
  form_pdf_field_mappings:
    "global reference data: which box on a USCIS blank a field key prints into; written only by platform admins",
  // The State Department's monthly Visa Bulletin, snapshotted. Published to the
  // world and identical for every firm — same category as the two above.
  visa_bulletin_cutoffs: "global reference data, identical for every firm",
  // USCIS fee schedule and the HHS poverty guidelines behind the I-864 income
  // threshold. Both are the government's published figures — same category again.
  filing_fee_schedule: "global reference data, identical for every firm",
  poverty_guidelines: "global reference data, identical for every firm",
  // NOTE: workflow_templates / workflow_modules / workflow_template_steps used to
  // be exempt here as pure platform blueprints. `workflow_templates` now carries a
  // nullable `organization_id` (null = system default, non-null = one firm's own
  // cloned copy — Decision 1, locked backbone + firm add-ons), so all three moved
  // to bespoke policies in rls.ts alongside `invoice_line_presets`, which already
  // solves the same "some rows are everyone's, some are one firm's" shape. See the
  // comment above `rlsWorkflowTemplatesOrg` in rls.ts for why the generic
  // `orgScoped`/`parentScoped` factories here don't fit: both would make the
  // null-org system-default rows invisible under RLS (`organization_id = current_org_id`
  // is never true for a NULL column), the same latent gap `intake_pipeline_templates`
  // and `intake_pipeline_template_steps` have above — not fixed here (out of scope
  // for this change), but not copied into the new tables either.

  // ── Content-addressed caches ─────────────────────────────────────────────
  // Keyed on a checksum: identical bytes resolve to one row whoever uploaded
  // them, so there is nothing tenant-scoped to filter on, and reaching a row
  // means already holding the checksum of a document you can see.
  document_analyses: "content-addressed cache keyed on checksum",
  document_photo_comparisons: "content-addressed cache keyed on checksum",
  email_domain_cache: "cache of public MX/provider lookups, no tenant data",
  email_discovery_cache: "cache of public provider discovery, no tenant data",

  // ── Cross-tenant by design ───────────────────────────────────────────────
  payment_webhook_events:
    "provider callbacks land before the tenant is resolved; the handler scopes them",
  contractors:
    "a contractor is a platform-level person who works for many firms",
  contractor_specialties: "hangs off contractors, which is cross-firm",
  contractor_payment_details:
    "hangs off contractors; gated by app-level permission",
  contractor_certification_documents:
    "hangs off contractors, which is cross-firm",
  contractor_identification_documents:
    "hangs off contractors, which is cross-firm",
  // The platform sends SMS from one number and email from one domain, so a STOP
  // and a hard bounce are facts about the address, not about one firm's
  // relationship with it. Both tables carry a nullable, unlinked
  // organization_id: a row scoped to no organization cannot be filtered by one.
  // Reached only through systemDb with an explicit address predicate — see
  // sms-inbound-messages.ts and email-suppressions.ts for the full reasoning.
  sms_inbound_messages:
    "opt-outs on ONE shared sender number; organization_id is nullable, so there is no tenant to scope by",
  email_suppressions:
    "bounces and complaints on ONE shared sending domain; suppressing for every firm is the point",
};
