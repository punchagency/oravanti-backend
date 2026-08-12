import type { EmailAttachment } from "../utils/email/email.types";
import type { NotificationEventKey } from "./events";

export type NotificationChannel = "email" | "sms" | "in_app";

/**
 * Who to tell, named by identity rather than by address.
 *
 * Callers pass "lead 123", not "bob@example.com". The address is resolved here,
 * once, so that consent, opt-out and suppression are checked against the same
 * row the address came from — a caller that passed a bare address could not be
 * checked at all, and that is exactly the path by which someone who texted STOP
 * receives another message.
 *
 * `external` is the escape hatch for genuinely address-only recipients (an
 * adverse party's counsel, a one-off). It skips the identity lookup and is
 * therefore never consent-checked for SMS — which is why it is email-only in
 * practice.
 */
export type NotificationRecipient =
  | { type: "lead"; id: string }
  | { type: "client"; id: string }
  | { type: "staff"; id: string }
  | { type: "user"; id: string }
  | { type: "external"; email?: string; phone?: string; name?: string };

export type ResolvedRecipient = {
  type: NotificationRecipient["type"];
  /** Null for `external`, which has an address but no row. */
  id: string | null;
  name: string;
  email: string | null;
  /** As stored — free text. Normalised to E.164 at send time, not here. */
  rawPhone: string | null;
  smsConsent: boolean;
  smsOptOutAt: Date | null;
};

export type NotifyInput = {
  organizationId: string;
  event: NotificationEventKey;
  recipients: NotificationRecipient[];
  /**
   * Template context. Must be JSON-serialisable: it is persisted to
   * `notifications.payload` and re-rendered verbatim on a retry.
   */
  context: Record<string, unknown>;
  /**
   * Per-send channel narrowing — the "Deliver via" pickers. Can only ever
   * intersect with what the event catalog already allows, never widen it.
   */
  channels?: NotificationChannel[];
  /** Idempotency key, unique per organization. A repeat insert is a no-op. */
  dedupeKey?: string;
  /** When to send. Null or past means now. */
  sendAt?: Date;
  /** Scenario links, for the communications panel and for follow-up hooks. */
  scenario?: {
    leadId?: string;
    clientId?: string;
    caseId?: string;
    invoiceId?: string;
    consultationId?: string;
  };
  /** The staff member whose action triggered this. */
  actorStaffId?: string | null;
  /** Email only, and deliberately not persisted — see notifications.payload. */
  attachments?: EmailAttachment[];
};

export type NotifyResultRow = {
  id: string;
  channel: NotificationChannel;
  status: string;
  skipReason: string | null;
};

export type NotifyResult = {
  notifications: NotifyResultRow[];
};

/**
 * Why a channel was not used.
 *
 * Kept as a union for call-site safety but stored as text, because the list of
 * ways a send can be blocked grows every time a gate is added.
 */
export type SkipReason =
  | "provider_unconfigured"
  | "no_consent"
  | "opted_out"
  | "email_suppressed_bounce"
  | "email_suppressed_complaint"
  | "email_suppressed_provider"
  | "firm_sms_disabled"
  | "preference_off"
  | "no_address"
  | "unparseable_phone"
  | "no_template"
  | "cancelled";

export type ChannelDecision =
  | { allowed: true }
  | { allowed: false; skipReason: SkipReason };
