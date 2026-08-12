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
