import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { env } from "../config/env";

/**
 * Phone number normalisation for SMS delivery.
 *
 * Phone numbers are stored across the schema as free text — `leads.phone`,
 * `clients.phone`, `staff.phone` and a dozen others — with no validation and no
 * agreed format. They hold whatever a human typed. Carriers need E.164, so
 * something has to reconcile the two.
 *
 * That reconciliation happens **at send time, in one place**, rather than by
 * rewriting the stored columns. A migration over existing free-text phones
 * would have to guess a country for every ambiguous row and would destroy the
 * original input while doing it; normalising on read leaves the typed value
 * intact and confines the guessing to a single function whose failures are
 * recorded rather than silent.
 */

/**
 * A number we could not turn into something dialable is not an error — it is a
 * recipient we cannot reach. Callers record `skipReason: "unparseable_phone"`
 * against the notification rather than throwing, so the reason is visible in
 * the UI instead of vanishing into a log line.
 */
export const toE164 = (
  raw: string | null | undefined,
  defaultRegion?: CountryCode,
): string | null => {
  if (!raw?.trim()) return null;

  const region =
    defaultRegion ?? (env.PHONE_DEFAULT_REGION as CountryCode | undefined);

  // `parsePhoneNumberFromString` returns undefined rather than throwing on
  // input it cannot make sense of, which is the behaviour we want here.
  const parsed = parsePhoneNumberFromString(raw.trim(), region);

  // `isValid()` is deliberately stricter than `isPossible()`: possible-only
  // numbers match a length rule but not any allocated range, and sending to one
  // spends money to reach nobody.
  if (!parsed?.isValid()) return null;

  return parsed.number;
};

/**
 * Human-readable rendering for UI and email bodies. Falls back to the raw
 * string, because showing someone the number they typed beats showing nothing.
 */
export const formatNational = (
  raw: string | null | undefined,
  defaultRegion?: CountryCode,
): string | null => {
  if (!raw?.trim()) return null;

  const region =
    defaultRegion ?? (env.PHONE_DEFAULT_REGION as CountryCode | undefined);
  const parsed = parsePhoneNumberFromString(raw.trim(), region);

  return parsed?.isValid() ? parsed.formatNational() : raw.trim();
};

/**
 * Masks all but the last four digits, for logs and audit surfaces where the
 * number identifies a person but does not need to be readable.
 */
export const maskPhone = (raw: string | null | undefined): string | null => {
  if (!raw?.trim()) return null;

  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);

  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};

/** True when the value is already exactly E.164 — no parsing, just the shape. */
export const isE164 = (value: string | null | undefined): boolean =>
  typeof value === "string" && /^\+[1-9]\d{1,14}$/.test(value);
