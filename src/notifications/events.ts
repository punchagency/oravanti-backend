/**
 * The catalog of things the system can tell someone about.
 *
 * Two vocabularies live here, and keeping them distinct is the point:
 *
 *   `NotificationEventKey` — what the code emits. One key per moment worth
 *   sending a message about, and there are far more of these than the settings
 *   screen shows.
 *
 *   `FirmPreferenceEventKey` — the ten toggles the firm settings screen
 *   renders. This is a PREFERENCE vocabulary, not a send vocabulary. It never
 *   had to map one-to-one onto the events, and it does not.
 *
 * The bridge is `NotificationEventDef.tier`. A transactional event ignores firm
 * preferences entirely — a firm switching "email off" must not silently break
 * its own intake by suppressing the questionnaire link its client is waiting
 * for. A preference-tier event is gated on the toggle named by `prefKey`.
 *
 * One real-world moment can legitimately produce both. A payment landing emits
 * `payment_receipt_sent` to the client (transactional — they are owed a
 * receipt) and `payment_received_staff` to the firm (preference — an alert they
 * may not want). Modelling them as one event would force a choice between
 * spamming staff and withholding receipts.
 */

// ─── Firm preference vocabulary ───────────────────────────────────────────────

/**
 * MUST stay in lockstep with `NotificationEventKey` in
 * oravanti/src/api/firm-settings.ts. The settings screen sends these strings
 * back verbatim and the API rejects anything else.
 */
export const FIRM_PREFERENCE_EVENTS = [
  "new_lead_submitted",
  "case_stage_changed",
  "deadline_approaching",
  "rfe_noid_received",
  "invoice_due",
  "payment_received",
  "staff_leave_request",
  "document_uploaded",
  "client_message_received",
  "certification_expiring",
] as const;

export type FirmPreferenceEventKey = (typeof FIRM_PREFERENCE_EVENTS)[number];

/**
 * Display labels, owned by the server.
 *
 * The API accepts a `label` on write and ignores it, always returning these.
 * Persisting client-supplied display strings into a settings table is how a
 * stored-XSS-shaped bug gets in, and there is no reason the client should be
 * authoritative about its own labels.
 */
export const FIRM_PREFERENCE_LABELS: Record<FirmPreferenceEventKey, string> = {
  new_lead_submitted: "New lead submitted",
  case_stage_changed: "Case stage changed",
  deadline_approaching: "Deadline approaching",
  rfe_noid_received: "RFE / NOID received",
  invoice_due: "Invoice due",
  payment_received: "Payment received",
  staff_leave_request: "Staff leave request",
  document_uploaded: "Document uploaded",
  client_message_received: "Client message received",
  certification_expiring: "Certification expiring",
};

/** Matches the frontend's buildDefaultPreferences(). SMS is opt-in. */
export const DEFAULT_CHANNEL_PREFERENCES = {
  email: true,
  sms: false,
  inApp: true,
} as const;

export const isFirmPreferenceEvent = (
  value: string,
): value is FirmPreferenceEventKey =>
  (FIRM_PREFERENCE_EVENTS as readonly string[]).includes(value);

// ─── Event catalog ────────────────────────────────────────────────────────────

export type NotificationEventDef = {
  /**
   * `transactional` ignores firm preferences entirely; `preference` is gated on
   * the toggle named by `prefKey`. See the header for why this distinction is
   * what reconciles ten toggles with two dozen events.
   */
  tier: "transactional" | "preference";
  /** Required when tier is "preference"; meaningless otherwise. */
  prefKey?: FirmPreferenceEventKey;
  /** Who this is for. Staff-facing events resolve recipients differently. */
  audience: "recipient" | "staff";
  /** Channels this event supports at all. A per-send picker may only narrow this. */
  channels: readonly ("email" | "sms" | "in_app")[];
  label: string;
  /**
   * Whether anything actually emits this yet.
   *
   * Four of the ten firm toggles describe things the product does not detect
   * (RFEs, certification expiry, leave requests, client messages). The settings
   * screen still shows them, so this field lets the check assert exactly which
   * are wired — a number that should only ever go up, and never silently down.
   */
  producer: "wired" | "none";
};

export const NOTIFICATION_EVENTS = {
  // ── Intake: transactional. The lead is waiting for these. ──────────────────
  questionnaire_sent: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Intake questionnaire sent",
    producer: "wired",
  },
  questionnaire_reminder: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Questionnaire reminder",
    producer: "wired",
  },
  missing_documents_requested: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Missing documents requested",
    producer: "wired",
  },
  consultation_booking_link: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Consultation booking link",
    producer: "wired",
  },

  // ── Consultation reminders: transactional, and time-critical. ──────────────
  consultation_reminder_24h: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Consultation reminder (24 hours)",
    producer: "wired",
  },
  consultation_reminder_1h: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Consultation reminder (1 hour)",
    producer: "wired",
  },
  /**
   * The second half of a deposit, asked for once the consultation has happened.
   *
   * Transactional: it carries a payment link for money the client has already
   * agreed to owe, so it is not something they can decline while keeping the
   * arrangement. Email only — a pay link is not a thing to fish out of a text.
   */
  consultation_balance_due: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email"],
    label: "Consultation balance due",
    producer: "wired",
  },

  // ── Finance ────────────────────────────────────────────────────────────────
  payment_followup: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email", "sms"],
    label: "Payment follow-up",
    producer: "wired",
  },
  /**
   * The client half of a payment landing. Transactional: someone who paid is
   * owed a receipt regardless of what the firm has toggled.
   */
  payment_receipt_sent: {
    tier: "transactional",
    audience: "recipient",
    channels: ["email"],
    label: "Payment receipt",
    producer: "wired",
  },
  /** The staff half of the same moment — an alert, which a firm may not want. */
  payment_received_staff: {
    tier: "preference",
    prefKey: "payment_received",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Payment received",
    producer: "wired",
  },

  // ── Staff alerts: preference-gated. ────────────────────────────────────────
  new_lead_submitted: {
    tier: "preference",
    prefKey: "new_lead_submitted",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "New lead submitted",
    producer: "wired",
  },
  task_assigned: {
    tier: "preference",
    prefKey: "case_stage_changed",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Task assigned",
    producer: "wired",
  },
  case_opened_staff: {
    tier: "preference",
    prefKey: "case_stage_changed",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Case opened",
    producer: "wired",
  },
  document_uploaded_staff: {
    tier: "preference",
    prefKey: "document_uploaded",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Document uploaded",
    producer: "wired",
  },

  // ── Fee agreement ──────────────────────────────────────────────────────────
  fee_agreement_signed: {
    tier: "preference",
    prefKey: "case_stage_changed",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Fee agreement signed",
    producer: "wired",
  },
  fee_agreement_declined: {
    tier: "preference",
    prefKey: "case_stage_changed",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Fee agreement declined",
    producer: "wired",
  },

  /*
    ── Workflow task deadlines ────────────────────────────────────────────────

    Emitted by the task-deadline sweep (`workflow/reminder.service.ts`), which
    walks open tasks with a due date and sends at most one message per
    threshold — 3 days out, 1 day out, then overdue — stamping the task so a
    reminder is never repeated.

    Due-soon and overdue are separate events rather than one with a flag,
    because they are different messages about different situations and a firm
    that wants the overdue alert may well not want two warnings before it.
    Both sit under `deadline_approaching`, which is the toggle a firm reads as
    covering exactly this — and both are distinct from `task_assigned` above,
    which is work landing on someone rather than a deadline approaching.

    Email and in-app only — a task is not worth a text message.
  */
  task_due_soon: {
    tier: "preference",
    prefKey: "deadline_approaching",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Task due soon",
    producer: "wired",
  },
  task_overdue: {
    tier: "preference",
    prefKey: "deadline_approaching",
    audience: "staff",
    channels: ["email", "in_app"],
    label: "Task overdue",
    producer: "wired",
  },
} as const satisfies Record<string, NotificationEventDef>;

export type NotificationEventKey = keyof typeof NOTIFICATION_EVENTS;

export const getEventDef = (event: NotificationEventKey): NotificationEventDef =>
  NOTIFICATION_EVENTS[event];
