/**
 * Template rendering primitives.
 *
 * The existing email templates in src/utils/email/email.types.ts interpolate
 * user data raw; only finance/deliveries.service.ts escapes. That was survivable
 * while every template was built inline from freshly-read values. It is not
 * survivable here, because notification templates render from `payload` jsonb
 * that was persisted earlier and contains names, subjects and free text the
 * client typed.
 *
 * So escaping is the default and bypassing it takes a deliberate `raw()`.
 * Retrofitting the existing templates is a separate change — this file does not
 * touch them.
 */

/** Lifted from src/modules/finance/deliveries.service.ts, which had the only copy. */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type RawHtml = { __raw: string };

const isRaw = (value: unknown): value is RawHtml =>
  typeof value === "object" && value !== null && "__raw" in value;

/**
 * Marks a string as already-safe HTML.
 *
 * Only for markup this file's callers constructed themselves — a list built
 * from escaped parts, a link whose href is an internal URL. Never for anything
 * that reached us from a request body.
 */
export const raw = (value: string): RawHtml => ({ __raw: value });

/**
 * Tagged template that escapes every interpolation.
 *
 *   html`<p>Dear ${name},</p>`   // name is escaped
 *   html`<div>${raw(rows)}</div>` // rows is trusted
 */
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string =>
  strings.reduce((acc, part, index) => {
    if (index === 0) return part;
    const value = values[index - 1];
    return acc + (isRaw(value) ? value.__raw : escapeHtml(value)) + part;
  }, "");

// ─── SMS ──────────────────────────────────────────────────────────────────────

/**
 * GSM-7 is the 7-bit alphabet carriers bill single-segment messages in. A body
 * that fits sends as one segment at 160 characters; a body containing anything
 * outside this set is re-encoded as UCS-2 and drops to 70. A single curly
 * quote, em dash or accented character therefore more than doubles the cost and
 * can silently split a message that looked fine in a code editor.
 *
 * The characters below are the standard GSM 03.38 basic set. The extension
 * table (^{}[]~|\ and €) technically encodes, but each costs two characters, so
 * they are excluded here rather than silently counted wrong.
 */
const GSM7_CHARS = new Set(
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\n\r".split(
    "",
  ),
);

export const isGsm7 = (body: string): boolean =>
  [...body].every((char) => GSM7_CHARS.has(char));

/**
 * How many segments a body will be billed as.
 *
 * Multi-segment messages lose 7 characters per segment to the concatenation
 * header, hence 153 and 67 rather than 160 and 70.
 */
export const gsmSegments = (body: string): number => {
  const length = [...body].length;
  if (isGsm7(body)) {
    return length <= 160 ? 1 : Math.ceil(length / 153);
  }
  return length <= 70 ? 1 : Math.ceil(length / 67);
};

/** Single-segment limits, exported so templates and checks agree on the number. */
export const SMS_SINGLE_SEGMENT_GSM7 = 160;
export const FIRM_PREFIX_MAX = 20;

/**
 * Builds the final SMS body, prefixed with the firm name.
 *
 * The prefix is not decoration. The platform sends every firm's messages from
 * ONE shared number, so without it a recipient gets an unexplained text from an
 * unknown number about their legal matter — which reads as a scam and earns a
 * spam report, and spam reports on a shared number degrade deliverability for
 * every firm on it.
 *
 * Truncated to 20 characters because the prefix competes with the message for
 * the 160-character segment, and a long firm name would push routine messages
 * into two segments.
 */
export const smsBody = (firmName: string, text: string): string => {
  const prefix = firmName.trim().slice(0, FIRM_PREFIX_MAX).trim();
  const body = prefix ? `${prefix}: ${text}` : text;

  if (gsmSegments(body) > 1) {
    // Not thrown: a two-segment message still arrives, and refusing to send a
    // consultation reminder because it is 12 characters long would be worse
    // than paying for it. The check asserts templates stay inside one segment;
    // this catches the ones that drift past it in production.
    console.warn(
      `[sms] body exceeds one segment (${gsmSegments(body)} segments, ${[...body].length} chars, gsm7=${isGsm7(body)})`,
    );
  }

  return body;
};
