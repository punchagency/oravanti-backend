/**
 * The log event catalogue — every event name the application can emit.
 *
 * `event` is the machine-readable key: it is what you filter, alert and chart
 * on, and it must be stable. `message` is prose for a human reading the console
 * and may be reworded freely. Keeping them separate is the whole reason for
 * this file — with a free-text message alone, a reworded sentence silently
 * breaks a dashboard, and "which errors are we seeing" cannot be answered
 * without regex archaeology across every call site.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * `domain.action`, lower_snake within each part, past tense for things that
 * happened (`email.sent`) and `_failed` for things that did not. The domain is
 * split onto every record automatically (see `log.ts`), so `domain:"queue"`
 * filters a whole subsystem without knowing its individual events.
 *
 * ── Why a const object and not a TS enum ────────────────────────────────────
 * `as const` gives the same autocomplete and the same compile error on a typo,
 * while staying a plain string at runtime — so it survives JSON, works in a
 * test literal, and needs no import in a log query. String enums additionally
 * behave nominally, which would force every helper signature to depend on this
 * module rather than on `string`.
 *
 * ── Two kinds of event ──────────────────────────────────────────────────────
 * ACTIONS are things a user or the system did — `case.created`, `auth.login`.
 * They are emitted on the success path and are the record of what happened.
 * DIAGNOSTICS are things that went wrong — `email.send_failed`. Both live here
 * so there is exactly one catalogue to consult.
 *
 * A logged action is not an audit trail: logs expire, and they cannot be
 * queried per client to answer "who opened this matter". Phase 3 adds durable
 * audit rows; these names are chosen to match what the trail will record, so
 * the two never drift apart.
 *
 * ── Adding one ──────────────────────────────────────────────────────────────
 * Add it here first. Nothing outside this file should pass a literal to the
 * `event` field; that is what makes the catalogue exhaustive rather than
 * aspirational. `events.test.ts` enforces the naming rules and uniqueness.
 */

export const LogEvent = {
  // ── Application lifecycle ─────────────────────────────────────────────────
  APP_STARTED: "app.started",
  APP_STOPPING: "app.stopping",
  APP_STOPPED: "app.stopped",
  APP_STARTUP_FAILED: "app.startup_failed",
  APP_UNCAUGHT_EXCEPTION: "app.uncaught_exception",
  APP_UNHANDLED_REJECTION: "app.unhandled_rejection",
  APP_SHUTDOWN_TIMEOUT: "app.shutdown_timeout",

  // ── Telemetry ─────────────────────────────────────────────────────────────
  /**
   * The observability pipeline reporting on itself.
   *
   * These exist so a broken exporter is visible in the one place that still
   * works when the collector is unreachable — stdout. Telemetry that fails
   * quietly reads downstream as "nothing went wrong", which is the most
   * expensive possible way for it to fail.
   */
  TELEMETRY_STARTED: "telemetry.started",
  TELEMETRY_DISABLED: "telemetry.disabled",
  TELEMETRY_START_FAILED: "telemetry.start_failed",
  TELEMETRY_SHUTDOWN_FAILED: "telemetry.shutdown_failed",
  TELEMETRY_ERROR: "telemetry.error",
  TELEMETRY_WARNING: "telemetry.warning",
  TELEMETRY_DIAGNOSTIC: "telemetry.diagnostic",

  // ── HTTP ──────────────────────────────────────────────────────────────────
  /**
   * A request arrived. Debug only, and off by default.
   *
   * The access log is written when a response finishes, so a request that
   * hangs, deadlocks, or takes the process down with it leaves no trace that it
   * ever arrived — which is precisely the request you need to see. Turning
   * LOG_LEVEL to debug pairs every completion with an arrival, and an arrival
   * with no completion is the one that killed you.
   */
  HTTP_REQUEST_RECEIVED: "http.request_received",
  /** One per completed request. The access log. */
  HTTP_REQUEST: "http.request",
  /**
   * The controller boundary — the request reached a handler, and the handler
   * returned. Debug, and written by `asyncWrap` rather than by any controller.
   *
   * The pair is what makes a request that died in authentication, validation
   * or a rate limiter distinguishable at a glance from one that reached the
   * business logic and failed there.
   */
  HTTP_HANDLER_STARTED: "http.handler_started",
  HTTP_HANDLER_COMPLETED: "http.handler_completed",
  /** 5xx — ours. Carries the stack; the response deliberately says nothing. */
  HTTP_REQUEST_FAILED: "http.request_failed",
  /** 4xx — the caller's. Expected traffic, so no stack. */
  HTTP_REQUEST_REJECTED: "http.request_rejected",

  // ── Database ──────────────────────────────────────────────────────────────
  DB_CONNECTED: "db.connected",
  DB_CONNECTION_FAILED: "db.connection_failed",
  DB_HEALTH_CHECK_FAILED: "db.health_check_failed",
  DB_QUERY_FAILED: "db.query_failed",
  DB_TRANSACTION_FAILED: "db.transaction_failed",
  DB_SLOW_QUERY: "db.slow_query",

  // ── Security ──────────────────────────────────────────────────────────────
  /** Postgres refused the row. A tenant boundary was crossed, or nearly was. */
  SECURITY_RLS_VIOLATION: "security.rls_violation",
  SECURITY_PERMISSION_DENIED: "security.permission_denied",
  SECURITY_RATE_LIMITED: "security.rate_limited",
  SECURITY_CORS_REJECTED: "security.cors_rejected",
  SECURITY_SUSPICIOUS_REQUEST: "security.suspicious_request",
  SECURITY_DEK_UNAVAILABLE: "security.dek_unavailable",
  SECURITY_DEK_INJECTION_FAILED: "security.dek_injection_failed",
  SECURITY_DEK_DECRYPT_FAILED: "security.dek_decrypt_failed",
  SECURITY_ENCRYPTION_FAILED: "security.encryption_failed",
  /**
   * A user's data encryption key was re-wrapped under the current master key.
   *
   * Emitted lazily, on the request that first encounters a key still wrapped
   * with SERVER_MASTER_KEY_OLD. Counting these is how a key rotation is known
   * to be finished — when the rate reaches zero, no user is on the old key and
   * the old key can be retired.
   */
  SECURITY_DEK_ROTATED: "security.dek_rotated",
  SECURITY_DEK_ROTATION_FAILED: "security.dek_rotation_failed",

  // ── Authentication ────────────────────────────────────────────────────────
  AUTH_LOGIN: "auth.login",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_LOGOUT: "auth.logout",
  AUTH_SIGNUP: "auth.signup",
  AUTH_SIGNUP_FAILED: "auth.signup_failed",
  AUTH_SESSION_CREATED: "auth.session_created",
  AUTH_SESSION_REFRESHED: "auth.session_refreshed",
  AUTH_SESSION_EXPIRED: "auth.session_expired",
  AUTH_SESSION_REVOKED: "auth.session_revoked",
  AUTH_SESSION_REVOKE_FAILED: "auth.session_revoke_failed",
  AUTH_PASSWORD_CHANGED: "auth.password_changed",
  AUTH_PASSWORD_CHANGE_FAILED: "auth.password_change_failed",
  AUTH_PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  AUTH_PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",
  AUTH_PASSWORD_RESET_FAILED: "auth.password_reset_failed",
  /** A one-time code was sent. `otpType` says which flow asked for it. */
  AUTH_OTP_SENT: "auth.otp_sent",
  AUTH_OTP_SEND_FAILED: "auth.otp_send_failed",
  AUTH_EMAIL_VERIFICATION_SENT: "auth.email_verification_sent",
  AUTH_EMAIL_VERIFIED: "auth.email_verified",
  AUTH_TWO_FACTOR_ENABLED: "auth.two_factor_enabled",
  AUTH_TWO_FACTOR_ENABLE_FAILED: "auth.two_factor_enable_failed",
  AUTH_TWO_FACTOR_DISABLED: "auth.two_factor_disabled",
  AUTH_TWO_FACTOR_DISABLE_FAILED: "auth.two_factor_disable_failed",
  AUTH_TWO_FACTOR_CHALLENGED: "auth.two_factor_challenged",
  /** Second factor accepted. `method` is "totp" or "backup_code". */
  AUTH_TWO_FACTOR_VERIFIED: "auth.two_factor_verified",
  AUTH_TWO_FACTOR_FAILED: "auth.two_factor_failed",
  AUTH_ACCOUNT_LOCKED: "auth.account_locked",
  AUTH_IMPERSONATION_STARTED: "auth.impersonation_started",
  AUTH_IMPERSONATION_ENDED: "auth.impersonation_ended",
  AUTH_SOCIAL_LINKED: "auth.social_linked",
  AUTH_SOCIAL_UNLINK_FAILED: "auth.social_unlink_failed",
  AUTH_HOOK_FAILED: "auth.hook_failed",
  /** Geo-locating a session's IP. Best effort; the session is created either way. */
  AUTH_GEO_LOOKUP_FAILED: "auth.geo_lookup_failed",
  AUTH_IP_LOOKUP_FAILED: "auth.ip_lookup_failed",

  // ── Invitations & onboarding ──────────────────────────────────────────────
  INVITATION_SENT: "invitation.sent",
  INVITATION_ACCEPTED: "invitation.accepted",
  INVITATION_REVOKED: "invitation.revoked",
  INVITATION_EXPIRED: "invitation.expired",
  ONBOARDING_STEP_COMPLETED: "onboarding.step_completed",
  ONBOARDING_COMPLETED: "onboarding.completed",
  ONBOARDING_STEP_REJECTED: "onboarding.step_rejected",

  // ── Users & staff ─────────────────────────────────────────────────────────
  STAFF_CREATED: "staff.created",
  STAFF_UPDATED: "staff.updated",
  STAFF_DEACTIVATED: "staff.deactivated",
  STAFF_REACTIVATED: "staff.reactivated",
  STAFF_ROLE_CHANGED: "staff.role_changed",
  STAFF_PERMISSIONS_CHANGED: "staff.permissions_changed",
  STAFF_PROFILE_UPDATED: "staff.profile_updated",
  STAFF_AVATAR_UPLOADED: "staff.avatar_uploaded",
  USER_PROFILE_UPDATED: "user.profile_updated",

  // ── Dynamic roles (firm-defined, via better-auth dynamicAccessControl) ─────
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",

  // ── Role groups (named bundles of roles assigned to sets of staff) ──────────
  ROLE_GROUP_CREATED: "role_group.created",
  ROLE_GROUP_UPDATED: "role_group.updated",
  ROLE_GROUP_DELETED: "role_group.deleted",

  // ── Staff availability ────────────────────────────────────────────────────
  STAFF_AVAILABILITY_UPDATED: "staff_availability.updated",
  STAFF_AVAILABILITY_BLOCKED: "staff_availability.blocked",

  // ── Contractors ───────────────────────────────────────────────────────────
  CONTRACTOR_REGISTERED: "contractor.registered",
  /** A registration the domain refused before any account was created. */
  CONTRACTOR_REGISTRATION_REJECTED: "contractor.registration_rejected",
  CONTRACTOR_REGISTRATION_FAILED: "contractor.registration_failed",
  /**
   * Uploaded files were deleted after the registration transaction failed.
   * The auth user survives the rollback — this is the line that says so.
   */
  CONTRACTOR_REGISTRATION_ROLLED_BACK: "contractor.registration_rolled_back",
  CONTRACTOR_ROLLBACK_FAILED: "contractor.rollback_failed",

  // ── Teams ─────────────────────────────────────────────────────────────────
  TEAM_CREATED: "team.created",
  TEAM_UPDATED: "team.updated",
  TEAM_DELETED: "team.deleted",
  TEAM_MEMBER_ADDED: "team.member_added",
  TEAM_MEMBER_REMOVED: "team.member_removed",

  // ── Organization ──────────────────────────────────────────────────────────
  ORGANIZATION_CREATED: "organization.created",
  ORGANIZATION_UPDATED: "organization.updated",
  ORGANIZATION_UPDATE_FAILED: "organization.update_failed",
  ORGANIZATION_SETTINGS_CHANGED: "organization.settings_changed",
  ORGANIZATION_SUBSCRIPTION_CHANGED: "organization.subscription_changed",
  ORGANIZATION_STAFF_INVITE_FAILED: "organization.staff_invite_failed",

  // ── Clients ───────────────────────────────────────────────────────────────
  CLIENT_CREATED: "client.created",
  CLIENT_UPDATED: "client.updated",
  CLIENT_ARCHIVED: "client.archived",
  CLIENT_DELETED: "client.deleted",
  CLIENT_PORTAL_INVITED: "client.portal_invited",
  CLIENT_PORTAL_ACCESS_GRANTED: "client.portal_access_granted",
  CLIENT_PORTAL_ACCESS_REVOKED: "client.portal_access_revoked",
  CLIENT_CONTACT_ADDED: "client.contact_added",
  CLIENT_CONTACT_REMOVED: "client.contact_removed",
  CLIENT_CONTACT_UPDATED: "client.contact_updated",
  CLIENT_CONTACT_DELETED: "client.contact_deleted",
  CLIENT_COMPANY_SET: "client.company_set",
  CLIENT_PORTAL_SESSION_REVOKED: "client.portal_session_revoked",
  CLIENT_PORTAL_STATUS_CHANGED: "client.portal_status_changed",
  CLIENT_PORTAL_INVITE_FAILED: "client.portal_invite_failed",

  // ── Leads ─────────────────────────────────────────────────────────────────
  LEAD_CREATED: "lead.created",
  LEAD_UPDATED: "lead.updated",
  LEAD_VIEWED: "lead.viewed",
  LEAD_DELETED: "lead.deleted",
  LEAD_STAGE_CHANGED: "lead.stage_changed",
  LEAD_ASSIGNED: "lead.assigned",
  LEAD_CONVERTED: "lead.converted",
  LEAD_DECLINED: "lead.declined",
  LEAD_NOTE_ADDED: "lead.note_added",
  LEAD_NOTE_CREATED: "lead_note.created",
  LEAD_NOTE_UPDATED: "lead_note.updated",
  LEAD_NOTE_DELETED: "lead_note.deleted",
  LEAD_NOTE_CREATION_REJECTED: "lead_note.creation_rejected",
  LEAD_NOTE_UPDATE_REJECTED: "lead_note.update_rejected",
  LEAD_NOTE_DELETE_REJECTED: "lead_note.delete_rejected",
  LEAD_CONFLICT_CHECK_RUN: "lead.conflict_check_run",
  LEAD_CONFLICT_CHECK_APPROVED: "lead.conflict_check_approved",
  LEAD_CONFLICT_CHECK_DECLINED: "lead.conflict_check_declined",
  LEAD_CONFLICT_OVERRIDDEN: "lead.conflict_overridden",
  LEAD_CONSULTATION_SCHEDULED: "lead.consultation_scheduled",
  LEAD_CONSULTATION_RESCHEDULED: "lead.consultation_rescheduled",
  LEAD_CONSULTATION_CANCELLED: "lead.consultation_cancelled",
  LEAD_FEE_AGREEMENT_SENT: "lead.fee_agreement_sent",
  LEAD_FEE_AGREEMENT_SIGNED: "lead.fee_agreement_signed",
  // Diagnostics
  LEAD_EVENT_WRITE_FAILED: "lead.event_write_failed",
  LEAD_EVENT_LOGGED: "lead_event.logged",
  LEAD_VIEW_LOG_FAILED: "lead.view_log_failed",
  LEAD_NOTE_SAVE_FAILED: "lead.note_save_failed",
  LEAD_CONSULTATION_NOTE_MIRROR_FAILED: "lead.consultation_note_mirror_failed",
  LEAD_CALENDAR_EVENT_FAILED: "lead.calendar_event_failed",
  LEAD_FEE_AGREEMENT_ARCHIVE_FAILED: "lead.fee_agreement_archive_failed",
  LEAD_PIPELINE_TEMPLATE_MISSING: "lead.pipeline_template_missing",
  LEADS_CONSULTATION_INVOICE_FAILED: "leads.consultation_invoice_failed",
  /**
   * The consultation completed but its `invoice_after` fee could not be
   * emailed. The invoice stands and the money is still owed — it just has
   * not been asked for, so this is the signal to ask by hand.
   */
  LEADS_CONSULTATION_INVOICE_SEND_FAILED: "leads.consultation_invoice_send_failed",
  /**
   * A payment was recorded but the consultation it pays for did not advance.
   * The money is on the ledger; the booking gate may still be closed.
   */
  LEADS_CONSULTATION_SETTLE_FAILED: "leads.consultation_settle_failed",
  /** An owed refund was turned into an assignable task for someone who can act. */
  LEADS_CONSULTATION_REFUND_TASK_CREATED: "leads.consultation_refund_task_created",
  /** The reminder failed to raise. The refund is still owed and now untracked. */
  LEADS_CONSULTATION_REFUND_TASK_FAILED: "leads.consultation_refund_task_failed",
  /** A no-show was resolved against the firm's policy (refund / void / task). */
  LEADS_CONSULTATION_NO_SHOW_SETTLED: "leads.consultation_no_show_settled",
  /**
   * A cancelled consultation left money with the firm that it did not return.
   *
   * Either the person cancelling lacks `finance:refund`, or part of the fee
   * arrived outside the processor and has to go back by hand. Logged at warn
   * because somebody still owes a client, and nothing else raises its voice
   * about it — the derived "refund owed" state is visible in the UI, but only
   * to whoever thinks to look.
   */
  LEADS_CONSULTATION_REFUND_OWED: "leads.consultation_refund_owed",
  LEADS_CONSULTATION_INVOICE_VOID_FAILED:
    "leads.consultation_invoice_void_failed",
  LEADS_FEE_AGREEMENT_INVOICE_FAILED: "leads.fee_agreement_invoice_failed",

  // ── Lead workflow ─────────────────────────────────────────────────────────
  LEAD_WORKFLOW_CREATED: "lead_workflow.created",
  LEAD_WORKFLOW_UPDATED: "lead_workflow.updated",
  LEAD_WORKFLOW_DELETED: "lead_workflow.deleted",
  LEAD_WORKFLOW_SUBMISSION_REJECTED: "lead_workflow.submission_rejected",
  LEAD_WORKFLOW_REOPEN_REJECTED: "lead_workflow.reopen_rejected",
  LEAD_WORKFLOW_APPROVE_REJECTED: "lead_workflow.approve_rejected",
  LEAD_WORKFLOW_REJECT_REJECTED: "lead_workflow.reject_rejected",

  // ── Cases ─────────────────────────────────────────────────────────────────
  CASE_CREATED: "case.created",
  CASE_UPDATED: "case.updated",
  CASE_VIEWED: "case.viewed",
  CASE_DELETED: "case.deleted",
  CASE_STATUS_CHANGED: "case.status_changed",
  CASE_ASSIGNED: "case.assigned",
  CASE_ARCHIVED: "case.archived",
  CASE_CLOSED: "case.closed",
  CASE_REOPENED: "case.reopened",
  CASE_NOTE_ADDED: "case.note_added",
  CASE_DEADLINE_SET: "case.deadline_set",
  CASE_WORKFLOW_STEP_COMPLETED: "case.workflow_step_completed",
  // Diagnostics
  CASE_EVENT_WRITE_FAILED: "case.event_write_failed",
  CASE_VIEW_LOG_FAILED: "case.view_log_failed",
  CASE_EVENT_LOGGED: "case.event_logged",

  // ── Case review ───────────────────────────────────────────────────────────
  CASE_REVIEW_RULE_FAILED: "case_review.rule_failed",
  CASE_REVIEW_SWEEP_STARTED: "case_review.sweep_started",
  CASE_REVIEW_SWEEP_COMPLETED: "case_review.sweep_completed",
  CASE_REVIEW_SWEEP_FAILED: "case_review.sweep_failed",
  CASE_REVIEW_ISSUE_RAISED: "case_review.issue_raised",
  CASE_REVIEW_ISSUE_RESOLVED: "case_review.issue_resolved",
  CASE_REVIEW_EVALUATED: "case_review.evaluated",
  CONSULTATION_AUTO_QUESTIONNAIRE_SKIPPED: "consultation.auto_questionnaire_skipped",
  TASK_REVIEW_EVENT_WRITE_FAILED: "task_review.event_write_failed",

  // ── Documents ─────────────────────────────────────────────────────────────
  DOCUMENT_UPLOADED: "document.uploaded",
  DOCUMENT_DOWNLOADED: "document.downloaded",
  DOCUMENT_VIEWED: "document.viewed",
  DOCUMENT_DELETED: "document.deleted",
  DOCUMENT_SHARED: "document.shared",
  DOCUMENT_SIGNATURE_REQUESTED: "document.signature_requested",
  DOCUMENT_SIGNED: "document.signed",
  DOCUMENT_UPLOAD_FAILED: "document.upload_failed",
  DOCUMENT_UPDATED: "document.updated",
  DOCUMENT_SHARING_CHANGED: "document.sharing_changed",
  DOCUMENT_LINKED_TO_CASE: "document.linked_to_case",
  DOCUMENT_STATUS_CHANGED: "document.status_changed",
  DOCUMENT_ARCHIVED: "document.archived",
  DOCUMENT_RESTORED: "document.restored",
  DOCUMENT_REQUEST_CREATED: "document.request_created",
  DOCUMENT_EXTERNAL_SUBMITTED: "document.external_submitted",
  DOCUMENT_REQUEST_REISSUED: "document.request_reissued",
  DOCUMENT_REQUEST_CANCELLED: "document.request_cancelled",
  DOCUMENT_REQUIREMENT_CREATED: "document_requirement.created",
  DOCUMENT_REQUIREMENT_UPDATED: "document_requirement.updated",
  DOCUMENT_REQUIREMENT_DELETED: "document_requirement.deleted",

  // ── Tasks & time ──────────────────────────────────────────────────────────
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  TASK_DELETED: "task.deleted",
  TIME_ENTRY_CREATED: "time_entry.created",
  TIME_ENTRY_UPDATED: "time_entry.updated",
  TIME_ENTRY_DELETED: "time_entry.deleted",

  // ── Calendar ──────────────────────────────────────────────────────────────
  CALENDAR_EVENT_CREATED: "calendar.event_created",
  CALENDAR_EVENT_UPDATED: "calendar.event_updated",
  CALENDAR_EVENT_CANCELLED: "calendar.event_cancelled",
  CALENDAR_EVENT_DELETED: "calendar.event_deleted",
  CALENDAR_UPDATE_REJECTED: "calendar.update_rejected",
  CALENDAR_DELETE_REJECTED: "calendar.delete_rejected",
  CALENDAR_SYNC_FAILED: "calendar.sync_failed",

  // ── Questionnaires ────────────────────────────────────────────────────────
  QUESTIONNAIRE_SENT: "questionnaire.sent",
  QUESTIONNAIRE_SUBMITTED: "questionnaire.submitted",
  QUESTIONNAIRE_REMINDER_SENT: "questionnaire.reminder_sent",
  QUESTIONNAIRE_SEND_FAILED: "questionnaire.send_failed",
  QUESTIONNAIRE_REMINDER_FAILED: "questionnaire.reminder_failed",
  /** A payment chase could not be sent on one of its chosen channels. */
  PAYMENT_FOLLOWUP_SEND_FAILED: "payment.followup_send_failed",

  // ── Finance ───────────────────────────────────────────────────────────────
  INVOICE_CREATED: "invoice.created",
  INVOICE_SENT: "invoice.sent",
  INVOICE_DUPLICATED: "invoice.duplicated",
  INVOICE_PAID: "invoice.paid",
  INVOICE_VOIDED: "invoice.voided",
  /**
   * Moved out of draft onto the books without being emailed — a fee the
   * firm collects face to face. Distinct from INVOICE_SENT, which implies
   * a delivery that in this case never happened.
   */
  INVOICE_ISSUED_WITHOUT_DELIVERY: "invoice.issued_without_delivery",
  INVOICE_DELIVERY_FAILED: "invoice.delivery_failed",
  INVOICE_SCHEDULE_DELIVERY_FAILED: "invoice.schedule_delivery_failed",
  INSTALMENT_CREATED: "instalment.created",
  INSTALMENT_REMINDER_SENT: "instalment.reminder_sent",
  REPORT_GENERATED: "report.generated",
  REPORT_EXPORT_FAILED: "report.export_failed",
  PAYMENT_RECEIVED: "payment.received",
  PAYMENT_REFUNDED: "payment.refunded",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_FOLLOWUP_EMAIL_FAILED: "payment.followup_email_failed",
  PAYMENT_WEBHOOK_RECEIVED: "payment.webhook_received",
  PAYMENT_WEBHOOK_REJECTED: "payment.webhook_rejected",
  PAYMENT_WEBHOOK_FAILED: "payment.webhook_failed",
  PAYMENT_WEBHOOK_PROCESSED: "payment_webhook.processed",
  PAYMENT_WEBHOOK_SIGNATURE_INVALID: "payment_webhook.signature_invalid",
  PAYMENT_WEBHOOK_DUPLICATE_SKIPPED: "payment_webhook.duplicate_skipped",
  /**
   * A webhook arrived, was genuine, and was deliberately not turned into a
   * payment. One event with a `reason` rather than three near-identical ones:
   * the transaction was not a client payment, carried no invoice reference, or
   * named a bank-account category we cannot assign to trust or operating.
   * Every one of them means money moved that this system did not record.
   */
  PAYMENT_WEBHOOK_TRANSACTION_SKIPPED: "payment_webhook.transaction_skipped",
  /**
   * A client paid at the processor against an invoice we have since VOIDED.
   *
   * The worst outcome in this file: real money moved and no ledger row can be
   * written for it, because `recordPayment` refuses a voided invoice by design
   * and reversing that would let a withdrawn invoice collect. Confido cannot
   * prevent it either — `removePaymentLink` is rejected once a link has any
   * transaction against it, which is precisely the partially-paid invoice most
   * likely to be voided.
   *
   * Deliberately terminal rather than retried: the invoice stays void, so no
   * number of attempts changes the outcome and retrying only delays the moment
   * a person finds out. Paired with a finance-trail entry on the invoice, since
   * this needs to reach the firm and not only the operator.
   */
  PAYMENT_WEBHOOK_VOIDED_INVOICE_PAYMENT:
    "payment_webhook.voided_invoice_payment",
  /**
   * Webhook events accepted but never handled.
   *
   * The failure this exists for is a worker that is running and consuming
   * nothing: the endpoint answers 200, the event row is claimed, and the money
   * is never recorded. Nothing else in the system notices, because every
   * surface reports success.
   */
  /**
   * The payment recorded, but the consultation it pays for did not advance.
   *
   * Deliberately not fatal to the webhook: a consultation that fails to move on
   * is recoverable by hand, a payment that fails to record is not. Logged so
   * the recoverable half is visible rather than silent.
   */
  PAYMENT_WEBHOOK_CONSULTATION_SETTLEMENT_FAILED:
    "payment_webhook.consultation_settlement_failed",
  PAYMENT_WEBHOOK_STALE_EVENTS_FOUND: "payment_webhook.stale_events_found",
  PAYMENT_WEBHOOK_STALENESS_SWEEP_FAILED:
    "payment_webhook.staleness_sweep_failed",
  PAYMENT_LINK_CREATED: "payment_link.created",
  PAYMENT_LINK_SENT: "payment_link.sent",
  PAYMENT_LINK_EXPIRED: "payment_link.expired",
  /**
   * Withdrawn at the processor because the invoice was voided, so the hosted
   * URL can no longer take money a voided invoice cannot record.
   */
  PAYMENT_LINK_RETIRED: "payment_link.retired",
  /** The link outlived its invoice: withdrawal failed and the URL may still pay. */
  PAYMENT_LINK_RETIRE_FAILED: "payment_link.retire_failed",
  FINANCE_EVENT_RECORDED: "finance.event_recorded",
  FINANCE_EVENT_QUERY_FAILED: "finance.event_query_failed",
  FEE_AGREEMENT_GENERATED: "fee_agreement.generated",
  FEE_AGREEMENT_SENT: "fee_agreement.sent",
  CONSULTATION_BILLING_GENERATED: "consultation_billing.generated",

  // ── Payment provider configuration ────────────────────────────────────────
  // Setting a firm up to take money. Each of these leaves the firm working but
  // configured differently from what was asked, so none of them can be silent.
  PAYMENT_SETTINGS_BRANDING_FAILED: "payment_settings.branding_failed",
  PAYMENT_SETTINGS_LOGO_UPLOAD_FAILED: "payment_settings.logo_upload_failed",
  PAYMENT_SETTINGS_PORTAL_INVITE_FAILED: "payment_settings.portal_invite_failed",
  /**
   * The firm's fee debit was pointed at a trust (IOLTA) account. Repointed at
   * operating, because taking processor fees out of client money is the error
   * this integration exists to avoid.
   */
  PAYMENT_SETTINGS_FEE_ACCOUNT_REPOINTED: "payment_settings.fee_account_repointed",
  PAYMENT_SETTINGS_FEE_ACCOUNT_UPDATE_FAILED:
    "payment_settings.fee_account_update_failed",
  /** The firm changed how settled a payment must be before it opens a case. */
  PAYMENT_SETTINGS_CLEARING_POLICY_SET: "payment_settings.clearing_policy_set",
  PAYMENT_SETTINGS_BANK_ACCOUNTS_UNAVAILABLE:
    "payment_settings.bank_accounts_unavailable",
  /**
   * A `statements` read was refused with "Access denied" and retried.
   *
   * Confido could not account for this ("I have not heard of this surfacing
   * before... I would treat it as temporary for now", Aug 2026) and asked for
   * timestamps, so this record exists to be handed back to them as much as to
   * explain a slow sync. If it ever stops being transient it will show up as a
   * retry that exhausted rather than as silence.
   */
  PAYMENT_SETTINGS_STATEMENTS_ACCESS_RETRIED:
    "payment_settings.statements_access_retried",
  CONSULTATION_BILLING_SENT: "consultation_billing.sent",
  BILLING_RATE_CREATED: "billing_rate.created",
  BILLING_RATE_UPDATED: "billing_rate.updated",
  BILLING_RATE_DELETED: "billing_rate.deleted",
  LINE_PRESET_CREATED: "line_preset.created",
  LINE_PRESET_UPDATED: "line_preset.updated",
  LINE_PRESET_DELETED: "line_preset.deleted",
  INVOICE_UPDATED: "invoice.updated",
  TIME_ENTRY_TIMER_STARTED: "time_entry.timer_started",
  TIME_ENTRY_TIMER_STOPPED: "time_entry.timer_stopped",
  EXPENSE_CREATED: "expense.created",
  TRUST_LEDGER_ENTRY_CREATED: "trust_ledger.entry_created",

  // ── Practice areas ────────────────────────────────────────────────────────
  PRACTICE_AREA_SUBSCRIBED: "practice_area.subscribed",
  PRACTICE_AREA_UNSUBSCRIBED: "practice_area.unsubscribed",

  // ── Email ─────────────────────────────────────────────────────────────────
  EMAIL_SENT: "email.sent",
  EMAIL_SEND_FAILED: "email.send_failed",
  EMAIL_DNS_RESOLUTION_FAILED: "email.dns_resolution_failed",
  EMAIL_ACCOUNT_LINKED: "email_account.linked",
  EMAIL_ACCOUNT_UNLINKED: "email_account.unlinked",
  EMAIL_ACCOUNT_UNLINK_FAILED: "email_account.unlink_failed",
  EMAIL_ACCOUNT_SYNC_FAILED: "email_account.sync_failed",
  EMAIL_ACCOUNT_LINK_FAILED: "email_account.link_failed",

  // ── Queue / workers ───────────────────────────────────────────────────────
  QUEUE_WORKERS_STARTED: "queue.workers_started",
  QUEUE_SHUTDOWN_REQUESTED: "queue.shutdown_requested",
  QUEUE_REDIS_ERROR: "queue.redis_error",
  QUEUE_JOB_ENQUEUED: "queue.job_enqueued",
  QUEUE_JOB_STARTED: "queue.job_started",
  QUEUE_JOB_COMPLETED: "queue.job_completed",
  QUEUE_JOB_FAILED: "queue.job_failed",
  QUEUE_JOB_CANCEL_FAILED: "queue.job_cancel_failed",
  QUEUE_REMINDER_SENT: "queue.reminder_sent",

  // ── AI scan ───────────────────────────────────────────────────────────────
  AI_SCAN_REQUESTED: "ai_scan.requested",
  AI_SCAN_COMPLETED: "ai_scan.completed",
  AI_SCAN_RESULT_ORPHANED: "ai_scan.result_orphaned",
  AI_SCAN_ISSUE_SYNC_FAILED: "ai_scan.issue_sync_failed",
  AI_SCAN_RESCAN_ENQUEUE_FAILED: "ai_scan.rescan_enqueue_failed",
  AI_SCAN_MARK_RUNNING_FAILED: "ai_scan.mark_running_failed",
  AI_SCAN_RECONCILIATION_FAILED: "ai_scan.reconciliation_failed",
  AI_SCAN_TRIGGER_FAILED: "ai_scan.trigger_failed",
  AI_SCAN_SCENARIO_RESOLVE_FAILED: "ai_scan.scenario_resolve_failed",

  // ── External integrations ─────────────────────────────────────────────────
  GOOGLE_MEET_LINK_CREATED: "google_meet.link_created",
  GOOGLE_MEET_LINK_CREATE_FAILED: "google_meet.link_create_failed",
  GOOGLE_MEET_EVENT_DELETE_FAILED: "google_meet.event_delete_failed",
  GOOGLE_MEET_CREDENTIALS_MISSING: "google_meet.credentials_missing",
  STORAGE_UPLOAD_FAILED: "storage.upload_failed",
  STORAGE_DOWNLOAD_FAILED: "storage.download_failed",
  INTEGRATION_REQUEST_FAILED: "integration.request_failed",

  // ── Notifications ─────────────────────────────────────────────────────────
  /**
   * A notify() call could not even be recorded.
   *
   * Note this is NOT "the message was not delivered" — a send that is
   * deliberately skipped, or that fails at the provider, is a row in
   * `notifications` with a reason, which is a far better record than a log
   * line. This event means the ledger write itself failed, so there is no row
   * and nothing else will ever mention it.
   */
  NOTIFICATION_DISPATCH_FAILED: "notification.dispatch_failed",
  /** The row was written but could not be queued; the sweep will pick it up. */
  NOTIFICATION_ENQUEUE_FAILED: "notification.enqueue_failed",
  NOTIFICATION_CANCEL_FAILED: "notification.cancel_failed",
  NOTIFICATION_SWEEP_COMPLETED: "notification.sweep_completed",
  NOTIFICATION_SWEEP_FAILED: "notification.sweep_failed",

  // ── SMS ───────────────────────────────────────────────────────────────────
  SMS_PROVIDER_SELECTED: "sms.provider_selected",
  SMS_PROVIDER_UNSET: "sms.provider_unset",
  /** SMS_PROVIDER held something we do not recognise — typo, or a vendor name that never shipped. */
  SMS_PROVIDER_UNRECOGNISED: "sms.provider_unrecognised",
  /** The named provider is missing credentials, so nothing will send. */
  SMS_PROVIDER_UNCONFIGURED: "sms.provider_unconfigured",
  SMS_WEBHOOK_SIGNATURE_INVALID: "sms.webhook_signature_invalid",
  /** A vendor sent a delivery status word its provider does not map. */
  SMS_STATUS_UNMAPPED: "sms.status_unmapped",
  SMS_INBOUND_RECEIVED: "sms.inbound_received",
  SMS_HELP_REPLY_FAILED: "sms.help_reply_failed",
  SMS_SENT: "sms.sent",
  SMS_SEND_FAILED: "sms.send_failed",
  /** No provider configured: the message was logged, not sent. */
  SMS_STUB_SEND: "sms.stub_send",
  /** A body that will be billed as more than one segment. */
  SMS_BODY_MULTI_SEGMENT: "sms.body_multi_segment",
  /** A recipient asked to stop, and it was applied across every organization. */
  SMS_OPT_OUT_APPLIED: "sms.opt_out_applied",
  SMS_OPT_IN_APPLIED: "sms.opt_in_applied",

  // ── Email suppression ─────────────────────────────────────────────────────
  EMAIL_SUPPRESSED: "email.suppressed",
  EMAIL_SUPPRESSION_LIFTED: "email.suppression_lifted",
  CONSULTATION_REMINDERS_SCHEDULE_FAILED:
    "consultation.reminders_schedule_failed",
  /**
   * Worse than failing to schedule: a reminder for a consultation that has been
   * moved or called off is still queued and will still fire.
   */
  CONSULTATION_REMINDERS_CANCEL_FAILED: "consultation.reminders_cancel_failed",

  // ── Consultation balance (deposit schedules) ──────────────────────────────
  /**
   * The client was never told the balance of their deposit is due. The money is
   * still on the invoice and still owed; nobody has asked for it.
   */
  CONSULTATION_BALANCE_NOTICE_FAILED: "consultation.balance_notice_failed",
  /**
   * Worse than failing to schedule one: a demand for the balance of a
   * consultation that has since been cancelled or refunded is still queued.
   */
  CONSULTATION_BALANCE_NOTICE_CANCEL_FAILED:
    "consultation.balance_notice_cancel_failed",
  /**
   * The lead picked a slot but the balance instalment kept the placeholder date
   * it was given at booking, so the balance falls due on the wrong day.
   */
  CONSULTATION_BALANCE_RESCHEDULE_FAILED:
    "consultation.balance_reschedule_failed",
  /**
   * The balance notice could not be given a payment link. It still goes out —
   * the client learns what is owed and can call the office — but they cannot
   * pay from the email.
   */
  CONSULTATION_BALANCE_LINK_FAILED: "consultation.balance_link_failed",
  /**
   * A no-show left an invoice the client had never been sent, and the attempt
   * to send it before chasing it failed. It will go overdue with no working
   * pay link behind it.
   */
  CONSULTATION_NO_SHOW_INVOICE_SEND_FAILED:
    "consultation.no_show_invoice_send_failed",

  // ── Audit trail ───────────────────────────────────────────────────────────
  /**
   * The audit row could not be written.
   *
   * Emitted only where the caller chose not to let the failure abort the
   * request — an observational record of something that already happened
   * elsewhere, such as a rejected sign-in. Everywhere else the insert throws
   * and the business change rolls back with it, so there is nothing to report
   * here. Treat this event as a gap in a legally-retained record and alert on
   * it accordingly.
   */
  AUDIT_WRITE_FAILED: "audit.write_failed",
  /** An access (view/download) row was lost. Never aborts the read it describes. */
  AUDIT_ACCESS_WRITE_FAILED: "audit.access_write_failed",
  /** A read of the trail itself, at `debug` — the audited record of it is the `audit_log.viewed` row. */
  AUDIT_QUERIED: "audit.queried",
  /**
   * Audit rows were destroyed by the retention job.
   *
   * An `action`, not an `info`: this is the one code path allowed to remove a
   * legally-retained record, and years later it must be possible to show that
   * a missing row was purged on schedule rather than never written.
   */
  AUDIT_RETENTION_PURGED: "audit.retention_purged",
  AUDIT_RETENTION_COMPLETED: "audit.retention_completed",
  /** The maintenance role is not configured, so nothing was purged. */
  AUDIT_RETENTION_SKIPPED: "audit.retention_skipped",
  AUDIT_RETENTION_FAILED: "audit.retention_failed",

  // ── Data movement ─────────────────────────────────────────────────────────
  DATA_EXPORTED: "data.exported",
  DATA_IMPORTED: "data.imported",
  DATA_BULK_DELETED: "data.bulk_deleted",

  // ── Workflow ──────────────────────────────────────────────────────────────
  WORKFLOW_TRIGGERED: "workflow.triggered",
  WORKFLOW_COMPLETED: "workflow.completed",
  WORKFLOW_SUBMIT_REJECTED: "workflow.submit_rejected",
  WORKFLOW_APPROVE_REJECTED: "workflow.approve_rejected",
  WORKFLOW_REJECT_REJECTED: "workflow.reject_rejected",
  WORKFLOW_REOPEN_REJECTED: "workflow.reopen_rejected",

  // ── Settings ──────────────────────────────────────────────────────────────
  SETTINGS_DATA_ACCESS_UPDATED: "settings.data_access_updated",
  SETTINGS_SECURITY_UPDATED: "settings.security_updated",
  SETTINGS_APPROVAL_WORKFLOW_UPDATED: "settings.approval_workflow_updated",
  SETTINGS_CONSULTATION_UPDATED: "settings.consultation_updated",
  SETTINGS_ACCESS_CONTROL_UPDATED: "settings.access_control_updated",
  SETTINGS_CERTIFICATION_GATE_UPDATED: "settings.certification_gate_updated",
  SETTINGS_FIRM_PROFILE_UPDATED: "settings.firm_profile_updated",
  SETTINGS_FINANCIAL_ACCESS_UPDATED: "settings.financial_access_updated",
  SETTINGS_FIRM_INFO_UPDATED: "settings.firm_info_updated",
  PERMISSION_AUDIT_QUERIED: "permission_audit.queried",
} as const;

/** Every valid value of the `event` field. */
export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];

export const LOG_EVENT_NAMES = Object.values(LogEvent) as LogEventName[];

/**
 * The subsystem an event belongs to — the part before the dot.
 *
 * Attached to every record so a whole subsystem can be filtered without
 * enumerating its events: `domain:"queue"` rather than a list of nine.
 */
export function domainOf(event: string): string {
  const dot = event.indexOf(".");
  return dot === -1 ? event : event.slice(0, dot);
}

/**
 * Fallback prose for a record whose caller supplied no message, so every line
 * is readable without forcing a hand-written sentence at every call site:
 * `ai_scan.issue_sync_failed` → `ai scan issue sync failed`.
 */
export function describeEvent(event: string): string {
  return event.replace(/[._]/g, " ");
}
