/**
 * The closed vocabulary of auditable actions.
 *
 * One registry, and the only place an action name may be introduced. A call
 * site never invents a string: `recordAuditEvent` accepts `AuditActionName`,
 * which is the union of the keys below, so an unknown action is a type error
 * rather than a row nobody can filter on.
 *
 * ─── Why a registry and not just a union ───────────────────────────────────
 *
 * Each action carries its category, its CRUD verb, the entity it acts on and
 * a human label. That metadata is what lets the writer fill four columns the
 * call site would otherwise have to repeat correctly every time, and what
 * lets the frontend render a feed without keeping its own copy of the
 * vocabulary. Two divergent copies of that map exist today — one in the case
 * audit-log tab and one in the lead audit-log tab — along with
 * `AUDIT_EVENT_TYPE_MAP` in `leads.service.ts`, which exists purely to
 * re-case values at read time because six of the eleven event tables use
 * pgEnums and five use free text. All three are retired by this file.
 *
 * ─── Naming ────────────────────────────────────────────────────────────────
 *
 * `<domain>.<verb>`, lowercase snake, always. The domain is the top-level
 * area a reader would look under, not the innermost entity — a step approval
 * is `case.step_approved`, because it belongs in a matter's timeline. This is
 * enforced by `__tests__/unit/audit/actions.test.ts`.
 *
 * ─── This file has no imports, deliberately ────────────────────────────────
 *
 * It is the shared vocabulary, so it must be copyable into the frontend
 * without dragging drizzle, the database, or anything else behind it. The
 * `audit_category` and `audit_action_type` pgEnums in
 * `db/schema/audit-events.ts` mirror the unions here; a test asserts they
 * have not drifted apart.
 */

/**
 * `access` is reserved for the entries in `ACCESS_ACTIONS` below and is never
 * written on an `AUDIT_ACTIONS` entry — that is what keeps a change from being
 * filed as a read now that both live in one table.
 */
export type AuditCategoryName =
  | "business"
  | "security"
  | "admin"
  | "system"
  | "access";

/** The CRUD verb behind the action, so a feed can be filtered without knowing the vocabulary. */
export type AuditActionTypeName = "create" | "read" | "update" | "delete";

export interface AuditActionDefinition {
  category: AuditCategoryName;
  actionType: AuditActionTypeName;
  /**
   * What the action acts on. The writer uses it as the default `entityType`,
   * so a call site passes only the id — which is what stops the same kind of
   * entity being recorded as "case" in one place and "cases" in another.
   */
  entityType: string;
  /** Short human phrase for a feed row. The frontend reads this; it does not keep its own copy. */
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit actions — things that changed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keyed by the action name itself, so the key is the value written to the
 * database and there is no second constant to keep in step with it.
 */
export const AUDIT_ACTIONS = {
  // ── Leads ────────────────────────────────────────────────────────────────
  // Replaces `lead_event_type` (53 values) and `lead_timeline_events`.
  "lead.received": { category: "business", actionType: "create", entityType: "lead", label: "Lead received" },
  "lead.updated": { category: "business", actionType: "update", entityType: "lead", label: "Lead updated" },
  "lead.stage_changed": { category: "business", actionType: "update", entityType: "lead", label: "Stage changed" },
  "lead.assigned": { category: "business", actionType: "update", entityType: "lead", label: "Lead assigned" },
  "lead.archived": { category: "business", actionType: "update", entityType: "lead", label: "Lead archived" },
  "lead.restored": { category: "business", actionType: "update", entityType: "lead", label: "Lead restored" },
  "lead.converted": { category: "business", actionType: "update", entityType: "lead", label: "Lead converted to case" },
  /** The matter this lead became. Distinct from `case.created`, which is the case's own row. */
  "lead.case_opened": { category: "business", actionType: "create", entityType: "case", label: "Case opened" },
  /** A step moved on the case this lead converted into, echoed onto the lead's own trail. */
  "lead.case_workflow_step_updated": { category: "business", actionType: "update", entityType: "workflow_step", label: "Case workflow step updated" },
  "lead.pipeline_initialized": { category: "business", actionType: "create", entityType: "lead", label: "Pipeline initialised" },
  "lead.nudge_sent": { category: "business", actionType: "create", entityType: "lead", label: "Nudge sent" },
  "lead.reminder_sent": { category: "business", actionType: "create", entityType: "lead", label: "Reminder sent" },

  "lead.note_added": { category: "business", actionType: "create", entityType: "lead_note", label: "Note added" },
  "lead.note_updated": { category: "business", actionType: "update", entityType: "lead_note", label: "Note updated" },
  "lead.note_deleted": { category: "business", actionType: "delete", entityType: "lead_note", label: "Note deleted" },
  "lead.note_pinned": { category: "business", actionType: "update", entityType: "lead_note", label: "Note pinned" },
  "lead.note_unpinned": { category: "business", actionType: "update", entityType: "lead_note", label: "Note unpinned" },

  "lead.conflict_check_run": { category: "business", actionType: "create", entityType: "conflict_check", label: "Conflict check run" },
  "lead.conflict_check_approved": { category: "business", actionType: "update", entityType: "conflict_check", label: "Conflict check cleared" },
  "lead.conflict_check_declined": { category: "business", actionType: "update", entityType: "conflict_check", label: "Conflict check declined" },
  "lead.conflict_overridden": { category: "business", actionType: "update", entityType: "conflict_check", label: "Conflict overridden" },

  "lead.questionnaire_sent": { category: "business", actionType: "create", entityType: "questionnaire", label: "Questionnaire sent" },
  "lead.questionnaire_opened": { category: "business", actionType: "read", entityType: "questionnaire", label: "Questionnaire opened" },
  "lead.questionnaire_draft_saved": { category: "business", actionType: "update", entityType: "questionnaire", label: "Questionnaire draft saved" },
  "lead.questionnaire_file_uploaded": { category: "business", actionType: "create", entityType: "questionnaire", label: "Questionnaire file uploaded" },
  "lead.questionnaire_response_received": { category: "business", actionType: "create", entityType: "questionnaire", label: "Questionnaire response received" },

  "lead.consultation_booking_opened": { category: "business", actionType: "read", entityType: "consultation", label: "Booking page opened" },
  "lead.consultation_slot_selected": { category: "business", actionType: "update", entityType: "consultation", label: "Consultation slot selected" },
  "lead.consultation_scheduled": { category: "business", actionType: "create", entityType: "consultation", label: "Consultation scheduled" },
  "lead.consultation_rescheduled": { category: "business", actionType: "update", entityType: "consultation", label: "Consultation rescheduled" },
  "lead.consultation_cancelled": { category: "business", actionType: "update", entityType: "consultation", label: "Consultation cancelled" },
  "lead.consultation_completed": { category: "business", actionType: "update", entityType: "consultation", label: "Consultation completed" },

  "lead.fee_agreement_generated": { category: "business", actionType: "create", entityType: "fee_agreement", label: "Fee agreement generated" },
  "lead.fee_agreement_sent": { category: "business", actionType: "update", entityType: "fee_agreement", label: "Fee agreement sent" },
  "lead.fee_agreement_signed": { category: "business", actionType: "update", entityType: "fee_agreement", label: "Fee agreement signed" },
  "lead.fee_agreement_discarded": { category: "business", actionType: "delete", entityType: "fee_agreement", label: "Fee agreement discarded" },
  "lead.fee_agreement_voided": { category: "business", actionType: "update", entityType: "fee_agreement", label: "Fee agreement voided" },
  "lead.payment_received": { category: "business", actionType: "create", entityType: "lead", label: "Payment received" },

  "lead.task_created": { category: "business", actionType: "create", entityType: "lead_task", label: "Task created" },
  "lead.task_updated": { category: "business", actionType: "update", entityType: "lead_task", label: "Task updated" },
  "lead.task_assigned": { category: "business", actionType: "update", entityType: "lead_task", label: "Task assigned" },
  "lead.task_status_changed": { category: "business", actionType: "update", entityType: "lead_task", label: "Task status changed" },
  "lead.task_completed": { category: "business", actionType: "update", entityType: "lead_task", label: "Task completed" },
  "lead.task_deleted": { category: "business", actionType: "delete", entityType: "lead_task", label: "Task deleted" },
  "lead.task_submitted_for_review": { category: "business", actionType: "update", entityType: "lead_task", label: "Task submitted for review" },
  "lead.task_approved": { category: "business", actionType: "update", entityType: "lead_task", label: "Task approved" },
  "lead.task_rejected": { category: "business", actionType: "update", entityType: "lead_task", label: "Task rejected" },
  "lead.task_reopened": { category: "business", actionType: "update", entityType: "lead_task", label: "Task reopened" },

  "lead.document_linked": { category: "business", actionType: "update", entityType: "document", label: "Document linked" },
  "lead.document_unlinked": { category: "business", actionType: "update", entityType: "document", label: "Document unlinked" },
  "lead.missing_documents_requested": { category: "business", actionType: "create", entityType: "lead", label: "Missing documents requested" },

  "lead.adverse_party_added": { category: "business", actionType: "create", entityType: "adverse_party", label: "Adverse party added" },
  "lead.adverse_party_updated": { category: "business", actionType: "update", entityType: "adverse_party", label: "Adverse party updated" },
  "lead.adverse_party_deleted": { category: "business", actionType: "delete", entityType: "adverse_party", label: "Adverse party removed" },

  // ── Cases ────────────────────────────────────────────────────────────────
  // Replaces `case_event_type`, `case_timeline_events`, `workflow_log` and
  // `step_action_logs`. The mirror-write that kept `workflow_log` and
  // `case_timeline_events` in sync goes away with them.
  "case.created": { category: "business", actionType: "create", entityType: "case", label: "Case opened" },
  "case.updated": { category: "business", actionType: "update", entityType: "case", label: "Case updated" },
  "case.deleted": { category: "business", actionType: "delete", entityType: "case", label: "Case deleted" },
  "case.description_updated": { category: "business", actionType: "update", entityType: "case", label: "Description updated" },
  "case.status_changed": { category: "business", actionType: "update", entityType: "case", label: "Status changed" },
  "case.priority_changed": { category: "business", actionType: "update", entityType: "case", label: "Priority changed" },
  "case.closed": { category: "business", actionType: "update", entityType: "case", label: "Case closed" },
  "case.reopened": { category: "business", actionType: "update", entityType: "case", label: "Case reopened" },
  "case.team_assigned": { category: "business", actionType: "update", entityType: "case", label: "Team assigned" },
  "case.team_reassigned": { category: "business", actionType: "update", entityType: "case", label: "Team reassigned" },

  "case.note_created": { category: "business", actionType: "create", entityType: "case_note", label: "Note added" },
  "case.note_updated": { category: "business", actionType: "update", entityType: "case_note", label: "Note updated" },
  "case.note_deleted": { category: "business", actionType: "delete", entityType: "case_note", label: "Note deleted" },
  "case.note_pinned": { category: "business", actionType: "update", entityType: "case_note", label: "Note pinned" },
  "case.note_unpinned": { category: "business", actionType: "update", entityType: "case_note", label: "Note unpinned" },

  "case.document_linked": { category: "business", actionType: "update", entityType: "document", label: "Document linked" },
  "case.document_unlinked": { category: "business", actionType: "update", entityType: "document", label: "Document unlinked" },

  "case.workflow_initialized": { category: "business", actionType: "create", entityType: "case", label: "Workflow initialised" },
  "case.module_activated": { category: "business", actionType: "update", entityType: "workflow_module", label: "Module activated" },
  // Ad-hoc case-attached tasks (`tasks.source = 'ad_hoc'`) — mirrors `lead.task_*`, distinct from the `case.step_*` family below which is workflow-sourced steps specifically.
  "case.task_created": { category: "business", actionType: "create", entityType: "task", label: "Task created" },
  "case.task_updated": { category: "business", actionType: "update", entityType: "task", label: "Task updated" },
  "case.step_created": { category: "business", actionType: "create", entityType: "workflow_step", label: "Step added" },
  "case.step_updated": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step updated" },
  "case.step_assigned": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step assigned" },
  "case.step_started": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step started" },
  "case.step_completed": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step completed" },
  "case.step_submitted_for_review": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step submitted for review" },
  "case.step_approved": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step approved" },
  "case.step_rejected": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step rejected" },
  "case.step_reopened": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step reopened" },
  "case.step_skipped": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step skipped" },
  // Withdrawn is the engine's decision, skipped is a person's: a step is withdrawn when the condition that
  // created it stops holding, and restored if it holds again. Neither ever deletes the task.
  "case.step_withdrawn": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step withdrawn" },
  "case.step_restored": { category: "business", actionType: "update", entityType: "workflow_step", label: "Step restored" },

  // Per-form tracking. A filing package is several forms, each with its own edition, fee, receipt number and
  // adjudication — `case.filed` is the package, these are the paper it is made of.
  "case.forms_initialized": { category: "business", actionType: "create", entityType: "case", label: "Filing package set up" },
  "case.form_updated": { category: "business", actionType: "update", entityType: "case_form", label: "Form updated" },
  "case.form_status_changed": { category: "business", actionType: "update", entityType: "case_form", label: "Form status changed" },
  "case.form_removed": { category: "business", actionType: "delete", entityType: "case_form", label: "Form removed" },

  /** The billing bridge — deliberately these two only, so a matter timeline is not a ledger. */
  "case.invoice_created": { category: "business", actionType: "create", entityType: "invoice", label: "Invoice raised" },
  "case.payment_received": { category: "business", actionType: "create", entityType: "invoice_payment", label: "Payment received" },

  // ── Case review ──────────────────────────────────────────────────────────
  // Replaces `case_issue_events`, whose `issue_id` cascades today.
  "case_review.issue_detected": { category: "business", actionType: "create", entityType: "case_issue", label: "Issue detected" },
  "case_review.issue_updated": { category: "business", actionType: "update", entityType: "case_issue", label: "Issue updated" },
  "case_review.issue_reopened": { category: "business", actionType: "update", entityType: "case_issue", label: "Issue reopened" },
  "case_review.issue_resolved": { category: "business", actionType: "update", entityType: "case_issue", label: "Issue resolved" },
  "case_review.issue_dismissed": { category: "business", actionType: "update", entityType: "case_issue", label: "Issue dismissed" },
  "case_review.issue_superseded": { category: "system", actionType: "update", entityType: "case_issue", label: "Issue superseded" },
  "case_review.scan_completed": { category: "system", actionType: "create", entityType: "case", label: "Review scan completed" },

  // ── Task review thread ───────────────────────────────────────────────────
  // `task-review-events.service.ts`'s append-only review conversation, shared
  // verbatim by both `case_step` and `lead_task` entities (`entityType` is the
  // `taskKind` the caller passes, not a fixed value) — one thread reader for
  // both, so it needs one action namespace, not two. This is distinct from the
  // per-domain `case.step_*`/`lead.task_*` events above: those describe what
  // happened for an activity feed; these are the thread's own entries. The
  // wider `task.*` family this used to include (created/updated/completed/
  // assigned) is gone — the old generic `tasks` table it audited is replaced
  // by the unified table, and case/lead-attached tasks now use `case.step_*`/
  // `lead.task_*` for those verbs.
  "task.submitted": { category: "business", actionType: "update", entityType: "task", label: "Submitted for review" },
  "task.approved": { category: "business", actionType: "update", entityType: "task", label: "Approved" },
  "task.rejected": { category: "business", actionType: "update", entityType: "task", label: "Rejected" },
  "task.reopened": { category: "business", actionType: "update", entityType: "task", label: "Reopened" },

  // ── Workflow templates ───────────────────────────────────────────────────
  // A firm customizing their own copy of a system-default template (Decision 1,
  // locked backbone + firm add-ons) — see workflow-template.service.ts.
  "workflow_template.created": { category: "business", actionType: "create", entityType: "workflow_template", label: "Workflow template created" },
  "workflow_template.updated": { category: "business", actionType: "update", entityType: "workflow_template", label: "Workflow template updated" },
  "workflow_template.archived": { category: "business", actionType: "update", entityType: "workflow_template", label: "Workflow template archived" },

  // ── Intake checklist ─────────────────────────────────────────────────────
  // The lead-side twin of `workflow_template.*`: a firm editing the fixed
  // checklist every new lead is stamped with. Its own domain rather than a
  // `workflow_template` verb because it is a different table with a different
  // editor — and because an intake lead is not a matter, so the two never
  // belong in the same filtered feed.
  "intake_pipeline.template_created": { category: "business", actionType: "create", entityType: "intake_pipeline_template", label: "Intake checklist created" },
  "intake_pipeline.template_updated": { category: "business", actionType: "update", entityType: "intake_pipeline_template", label: "Intake checklist updated" },

  // ── Case linking ─────────────────────────────────────────────────────────
  // Mandamus/appeal/related-matter linking via `cases.parentCaseId`.
  "case.linked": { category: "business", actionType: "update", entityType: "case", label: "Case linked" },
  "case.unlinked": { category: "business", actionType: "update", entityType: "case", label: "Case unlinked" },

  // ── Case milestones ──────────────────────────────────────────────────────
  // What the agency did and when (a receipt notice, an appointment, a
  // decision). The milestone row itself lives in `case_milestones`; these are
  // the firm-side record of someone entering or correcting it.
  "case.milestone_recorded": { category: "business", actionType: "create", entityType: "case", label: "Milestone recorded" },
  "case.milestone_corrected": { category: "business", actionType: "update", entityType: "case", label: "Milestone corrected" },

  // ── Notifications ────────────────────────────────────────────────────────
  // Best-effort visibility into the notification service — not every routine
  // reminder needs a row here, only ones tied to a case-facing event (see the
  // call sites in notification.service.ts).
  "notification.sent": { category: "business", actionType: "create", entityType: "notification", label: "Notification sent" },
  "notification.failed": { category: "system", actionType: "create", entityType: "notification", label: "Notification failed" },

  // ── Clients ──────────────────────────────────────────────────────────────
  "client.created": { category: "business", actionType: "create", entityType: "client", label: "Client created" },
  "client.updated": { category: "business", actionType: "update", entityType: "client", label: "Client updated" },
  "client.archived": { category: "business", actionType: "update", entityType: "client", label: "Client archived" },
  "client.restored": { category: "business", actionType: "update", entityType: "client", label: "Client restored" },
  "client.deleted": { category: "business", actionType: "delete", entityType: "client", label: "Client deleted" },
  "client.contact_added": { category: "business", actionType: "create", entityType: "client_contact", label: "Contact added" },
  "client.contact_updated": { category: "business", actionType: "update", entityType: "client_contact", label: "Contact updated" },
  "client.contact_removed": { category: "business", actionType: "delete", entityType: "client_contact", label: "Contact removed" },
  "client.portal_invited": { category: "business", actionType: "create", entityType: "client", label: "Portal invitation sent" },
  "client.portal_session_revoked": { category: "security", actionType: "delete", entityType: "session", label: "Client portal session revoked" },
  "client.portal_status_changed": { category: "business", actionType: "update", entityType: "client", label: "Portal status changed" },
  "client.profile_updated": { category: "business", actionType: "update", entityType: "client", label: "Client profile updated" },
  "client.avatar_updated": { category: "business", actionType: "update", entityType: "client", label: "Client avatar updated" },

  // ── Documents ────────────────────────────────────────────────────────────
  // Replaced `document_activity_logs` and its eleven raw inline inserts.
  // That table had no organization_id, so it was the one audit trail no tenant
  // filter could reach. The two read actions are recorded as access events,
  // which live in this table under the `access` category.
  "document.created": { category: "business", actionType: "create", entityType: "document", label: "Document uploaded" },
  "document.version_uploaded": { category: "business", actionType: "create", entityType: "document", label: "New version uploaded" },
  "document.renamed": { category: "business", actionType: "update", entityType: "document", label: "Document renamed" },
  "document.archived": { category: "business", actionType: "update", entityType: "document", label: "Document archived" },
  "document.restored": { category: "business", actionType: "update", entityType: "document", label: "Document restored" },
  "document.soft_deleted": { category: "business", actionType: "delete", entityType: "document", label: "Document deleted" },
  "document.access_granted": { category: "admin", actionType: "update", entityType: "document", label: "Access granted" },
  "document.access_revoked": { category: "admin", actionType: "update", entityType: "document", label: "Access revoked" },
  "document.external_request_created": { category: "business", actionType: "create", entityType: "document_request", label: "Document request sent" },
  "document.external_submission_uploaded": { category: "business", actionType: "create", entityType: "document_request", label: "Requested document submitted" },

  // ── Finance ──────────────────────────────────────────────────────────────
  // Replaces `finance_event_type` (15 values).
  "finance.invoice_created": { category: "business", actionType: "create", entityType: "invoice", label: "Invoice created" },
  "finance.invoice_updated": { category: "business", actionType: "update", entityType: "invoice", label: "Invoice updated" },
  "finance.invoice_sent": { category: "business", actionType: "update", entityType: "invoice", label: "Invoice sent" },
  "finance.invoice_voided": { category: "business", actionType: "update", entityType: "invoice", label: "Invoice voided" },
  "finance.invoice_paid": { category: "business", actionType: "update", entityType: "invoice", label: "Invoice paid" },
  "finance.invoice_partially_paid": { category: "business", actionType: "update", entityType: "invoice", label: "Invoice partially paid" },
  "finance.invoice_schedule_set": { category: "business", actionType: "create", entityType: "invoice", label: "Payment schedule set" },
  "finance.invoice_schedule_revised": { category: "business", actionType: "update", entityType: "invoice", label: "Payment schedule revised" },
  "finance.invoice_schedule_removed": { category: "business", actionType: "delete", entityType: "invoice", label: "Payment schedule removed" },
  "finance.payment_recorded": { category: "business", actionType: "create", entityType: "invoice_payment", label: "Payment recorded" },
  // One action for all four ways money goes back out — refund, ACH return, void
  // and chargeback. Which one it was is in the summary and the metadata; four
  // near-identical actions would buy nothing a reader of the trail can use.
  "finance.payment_reversed": { category: "business", actionType: "create", entityType: "invoice_payment", label: "Payment reversed" },
  "finance.payment_followup_sent": { category: "business", actionType: "create", entityType: "invoice", label: "Payment follow-up sent" },
  "finance.time_entry_logged": { category: "business", actionType: "create", entityType: "time_entry", label: "Time logged" },
  "finance.time_entry_approved": { category: "business", actionType: "update", entityType: "time_entry", label: "Time approved" },
  "finance.time_entry_rejected": { category: "business", actionType: "update", entityType: "time_entry", label: "Time rejected" },
  "finance.billing_rate_changed": { category: "admin", actionType: "update", entityType: "billing_rate", label: "Billing rate changed" },

  // ── Authentication (security) ────────────────────────────────────────────
  //
  // Zero coverage today: `auth.service.ts` contains no audit write at all.
  // For a product holding privileged client data, unrecorded failed logins is
  // the single gap that matters most — it is what an alerting rule watches and
  // what an incident review starts from. These rows are frequently org-less,
  // which is why `audit_events.organization_id` is nullable.
  //
  // The email address is recorded and is NOT redacted. It is the identifier
  // that makes an authentication incident investigable at all.
  "auth.login": { category: "security", actionType: "create", entityType: "session", label: "Signed in" },
  "auth.login_failed": { category: "security", actionType: "read", entityType: "session", label: "Sign-in failed" },
  "auth.logout": { category: "security", actionType: "delete", entityType: "session", label: "Signed out" },
  "auth.signup": { category: "security", actionType: "create", entityType: "user", label: "Account created" },
  "auth.signup_failed": { category: "security", actionType: "create", entityType: "user", label: "Account creation failed" },
  "auth.session_revoked": { category: "security", actionType: "delete", entityType: "session", label: "Session revoked" },
  "auth.password_changed": { category: "security", actionType: "update", entityType: "user", label: "Password changed" },
  /** A change refused for a wrong current password — a session-holder guessing at credentials. */
  "auth.password_change_failed": { category: "security", actionType: "update", entityType: "user", label: "Password change failed" },
  "auth.password_reset_requested": { category: "security", actionType: "read", entityType: "user", label: "Password reset requested" },
  "auth.password_reset_completed": { category: "security", actionType: "update", entityType: "user", label: "Password reset completed" },
  /** A reset refused for a bad or expired code. Repeats against one address are the takeover signal. */
  "auth.password_reset_failed": { category: "security", actionType: "update", entityType: "user", label: "Password reset failed" },
  "auth.email_verified": { category: "security", actionType: "update", entityType: "user", label: "Email verified" },
  "auth.two_factor_enabled": { category: "security", actionType: "update", entityType: "user", label: "Two-factor enabled" },
  "auth.two_factor_disabled": { category: "security", actionType: "update", entityType: "user", label: "Two-factor disabled" },
  "auth.two_factor_challenged": { category: "security", actionType: "read", entityType: "session", label: "Second factor requested" },
  "auth.two_factor_verified": { category: "security", actionType: "create", entityType: "session", label: "Second factor accepted" },
  "auth.two_factor_failed": { category: "security", actionType: "read", entityType: "session", label: "Second factor rejected" },
  "auth.backup_code_used": { category: "security", actionType: "update", entityType: "user", label: "Backup code used" },

  // ── Security (non-authentication) ────────────────────────────────────────
  /** An RLS policy refused a query. Belongs in the database, not only the log stream, because alerting reads this table. */
  "security.rls_violation": { category: "security", actionType: "read", entityType: "organization", label: "Tenant isolation violation" },
  "security.permission_denied": { category: "security", actionType: "read", entityType: "organization", label: "Permission denied" },
  "security.rate_limited": { category: "security", actionType: "read", entityType: "organization", label: "Rate limit exceeded" },

  // ── Administration ───────────────────────────────────────────────────────
  //
  // Near-zero coverage today: `organization.service.ts` hard-deletes `user`
  // and `staff` rows in three places with no audit write of any kind.
  "admin.staff_invited": { category: "admin", actionType: "create", entityType: "staff", label: "Staff invited" },
  "admin.staff_invitation_revoked": { category: "admin", actionType: "delete", entityType: "staff", label: "Invitation revoked" },
  "admin.staff_created": { category: "admin", actionType: "create", entityType: "staff", label: "Staff added" },
  "admin.staff_updated": { category: "admin", actionType: "update", entityType: "staff", label: "Staff updated" },
  "admin.staff_deleted": { category: "admin", actionType: "delete", entityType: "staff", label: "Staff removed" },
  "admin.staff_deactivated": { category: "admin", actionType: "update", entityType: "staff", label: "Staff deactivated" },
  "admin.staff_reactivated": { category: "admin", actionType: "update", entityType: "staff", label: "Staff reactivated" },
  "admin.staff_role_changed": { category: "admin", actionType: "update", entityType: "staff", label: "Role changed" },
  "admin.user_deleted": { category: "admin", actionType: "delete", entityType: "user", label: "User account deleted" },

  "admin.team_created": { category: "admin", actionType: "create", entityType: "team", label: "Team created" },
  "admin.team_updated": { category: "admin", actionType: "update", entityType: "team", label: "Team updated" },
  "admin.team_deleted": { category: "admin", actionType: "delete", entityType: "team", label: "Team deleted" },
  "admin.team_member_added": { category: "admin", actionType: "create", entityType: "team", label: "Team member added" },
  "admin.team_member_removed": { category: "admin", actionType: "delete", entityType: "team", label: "Team member removed" },

  // Replaces `permission_audit_log`, which records only a free-text action and
  // who changed it — no before, no after, so it cannot answer what changed.
  "admin.permission_changed": { category: "admin", actionType: "update", entityType: "permission", label: "Permissions changed" },
  // `financial_access_controls` is a real, enforced table (see
  // `modules/finance/account-access.ts`) — not superseded by dynamic RBAC,
  // since it answers a firm-specific trust/IOLTA question `ac` doesn't model.
  "admin.financial_access_changed": { category: "admin", actionType: "update", entityType: "permission", label: "Financial access changed" },

  // Dynamic role management (custom roles created/edited/deleted per firm via
  // better-auth's dynamicAccessControl). `admin.staff_role_changed` above
  // covers assigning an existing role to a staff member; these cover the
  // role definitions themselves.
  "role.created": { category: "admin", actionType: "create", entityType: "permission", label: "Role created" },
  "role.updated": { category: "admin", actionType: "update", entityType: "permission", label: "Role updated" },
  "role.deleted": { category: "admin", actionType: "delete", entityType: "permission", label: "Role deleted" },
  "role.permissions_changed": { category: "admin", actionType: "update", entityType: "permission", label: "Role permissions changed" },

  "role_group.created": { category: "admin", actionType: "create", entityType: "permission", label: "Role group created" },
  "role_group.updated": { category: "admin", actionType: "update", entityType: "permission", label: "Role group updated" },
  "role_group.deleted": { category: "admin", actionType: "delete", entityType: "permission", label: "Role group deleted" },
  "role_group.member_added": { category: "admin", actionType: "update", entityType: "permission", label: "Member added to role group" },
  "role_group.member_removed": { category: "admin", actionType: "update", entityType: "permission", label: "Member removed from role group" },

  "admin.client_portal_granted": { category: "admin", actionType: "update", entityType: "client", label: "Portal access granted" },
  "admin.client_portal_revoked": { category: "admin", actionType: "update", entityType: "client", label: "Portal access revoked" },
  "admin.contractor_registered": { category: "admin", actionType: "create", entityType: "contractor", label: "Contractor registered" },
  "admin.firm_profile_updated": { category: "admin", actionType: "update", entityType: "organization", label: "Firm profile updated" },
  "admin.staff_invite_failed": { category: "admin", actionType: "create", entityType: "staff", label: "Staff invitation failed" },
  "admin.password_changed": { category: "admin", actionType: "update", entityType: "user", label: "Password changed" },
  "admin.assigned_to_team": { category: "admin", actionType: "update", entityType: "team", label: "Staff assigned to team" },
  "admin.practice_areas_changed": { category: "admin", actionType: "update", entityType: "organization", label: "Practice areas changed" },

  /**
   * The most destructive operation in the system, and the one that today runs
   * without a trace — the firm data reset hard-deletes six of the eleven audit
   * tables. This row must survive it, so the reset never touches
   * `audit_events`, and it names who ran it and what was removed.
   */
  "admin.firm_data_reset": { category: "admin", actionType: "delete", entityType: "organization", label: "Firm data reset" },

  // ── System ───────────────────────────────────────────────────────────────
  // No human actor. Recorded so an automated change is never mistaken for one
  // a person made.
  "system.org_created": { category: "system", actionType: "create", entityType: "organization", label: "Organization created" },
  "system.settings_changed": { category: "system", actionType: "update", entityType: "organization", label: "Settings changed" },
  "system.retention_purge": { category: "system", actionType: "delete", entityType: "organization", label: "Retention purge" },
  "system.dek_rotated": { category: "system", actionType: "update", entityType: "organization", label: "Encryption key rotated" },
  "system.integration_sync": { category: "system", actionType: "update", entityType: "organization", label: "Integration synchronised" },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditActionName = keyof typeof AUDIT_ACTIONS;

// ─────────────────────────────────────────────────────────────────────────────
// Access actions — things that were looked at
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A separate registry, not a category on the one above, so that
 * `recordAuditEvent` cannot be handed a view action and `recordAccessEvent`
 * cannot be handed a state change.
 *
 * Both writers target the same table. The separation is a type-level one, and
 * it is the only thing left enforcing the distinction now that the storage no
 * longer does — which makes it more load-bearing than before, not less. Every
 * entry is `category: "access"` and `actionType: "read"` by definition, so
 * neither is repeated.
 */
export type AccessActionDefinition = Omit<AuditActionDefinition, "category" | "actionType">;

export const ACCESS_ACTIONS = {
  "lead.viewed": { entityType: "lead", label: "Lead viewed" },
  "case.viewed": { entityType: "case", label: "Case viewed" },
  "client.viewed": { entityType: "client", label: "Client viewed" },
  "document.viewed": { entityType: "document", label: "Document viewed" },
  "document.downloaded": { entityType: "document", label: "Document downloaded" },
  "invoice.viewed": { entityType: "invoice", label: "Invoice viewed" },
  "invoice.downloaded": { entityType: "invoice", label: "Invoice downloaded" },
  "case.exported": { entityType: "case", label: "Case exported" },
  "case_review.exported": { entityType: "case", label: "Case review exported" },
  /** Reading the audit trail is itself auditable — the first thing an auditor asks. */
  "audit_log.viewed": { entityType: "audit_log", label: "Audit log viewed" },
  "audit_log.exported": { entityType: "audit_log", label: "Audit log exported" },
} as const satisfies Record<string, AccessActionDefinition>;

export type AccessActionName = keyof typeof ACCESS_ACTIONS;

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditActionName[];
export const ACCESS_ACTION_NAMES = Object.keys(ACCESS_ACTIONS) as AccessActionName[];

export const isAuditAction = (value: string): value is AuditActionName =>
  Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value);

export const isAccessAction = (value: string): value is AccessActionName =>
  Object.prototype.hasOwnProperty.call(ACCESS_ACTIONS, value);

/**
 * The domain half of the action name — "lead", "case", "auth". Used to group a feed.
 *
 * Takes a plain `string` for the same reason `labelFor` does: a row read back
 * from the table may carry an action written by a newer deployment, and a feed
 * must still be able to group it.
 */
export const domainOf = (action: string): string =>
  action.slice(0, action.indexOf("."));

/**
 * The label for either kind of action.
 *
 * Falls back to the raw name rather than throwing: a feed rendering a row
 * written by a newer deployment should show something readable, not fail.
 */
export function labelFor(action: string): string {
  if (isAuditAction(action)) return AUDIT_ACTIONS[action].label;
  if (isAccessAction(action)) return ACCESS_ACTIONS[action].label;
  return action;
}
