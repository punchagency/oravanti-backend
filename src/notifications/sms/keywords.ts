/**
 * Opt-out keyword recognition.
 *
 * Twilio's Advanced Opt-Out already handles these at the carrier level on a
 * Messaging Service, and it stays enabled — it is stronger than anything we can
 * do, because it blocks before a message is ever sent. This exists so OUR
 * database agrees with that decision: without it, a contact who texted STOP
 * would still read as consenting in the app, staff would see no opt-out badge,
 * and every send would produce a Twilio rejection instead of an honest skip.
 *
 * The keyword lists are Twilio's published sets. Matching is deliberately
 * strict — the entire message, trimmed and case-folded, must be the keyword.
 * A message reading "please stop sending me so many forms" is a complaint to
 * act on, not an opt-out to apply silently, and treating it as one would drop a
 * client's SMS without them ever asking.
 */

const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
]);

const START_WORDS = new Set(["start", "yes", "unstop"]);

const HELP_WORDS = new Set(["help", "info"]);

export type SmsKeyword = "STOP" | "START" | "HELP";

export const classifyKeyword = (body: string): SmsKeyword | null => {
  // Punctuation is stripped so "STOP." and "STOP!" still count — people add it,
  // and Twilio accepts it too, so our record must not disagree.
  const normalised = body
    .trim()
    .toLowerCase()
    .replace(/[.!,?]+$/, "")
    .trim();

  if (STOP_WORDS.has(normalised)) return "STOP";
  if (START_WORDS.has(normalised)) return "START";
  if (HELP_WORDS.has(normalised)) return "HELP";

  return null;
};

/**
 * The reply to HELP.
 *
 * Carriers require an identifiable HELP response. Kept short and free of
 * anything outside GSM-7, so it stays one segment.
 */
export const HELP_REPLY =
  "Oravanti: legal intake messages from your law firm. Reply STOP to unsubscribe. Msg&data rates may apply.";
