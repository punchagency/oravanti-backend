import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export { dayjs };

/**
 * Central datetime utility. The three-layer model:
 *   - Storage/transport: always UTC (Postgres `timestamp without time zone`,
 *     ISO-8601 strings on the wire).
 *   - Business logic: computed in the firm's timezone (office hours, scheduling,
 *     deadlines, reporting period boundaries).
 *   - Presentation: localized per-recipient with an explicit zone label.
 *
 * `tz` parameters are IANA timezone identifiers (e.g. "America/New_York").
 * Helpers default to UTC when no timezone is supplied.
 */

export const DEFAULT_TZ = "UTC";

type DateInput = Date | string | number | dayjs.Dayjs;

/** True when `tz` is a valid IANA timezone identifier the runtime recognizes. */
export const isValidTimezone = (tz: string): boolean => {
  if (!tz) return false;
  try {
    // Throws RangeError for unrecognized identifiers.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// ─── Basic UTC parsing / emitting ─────────────────────────────────────────────

/** Current instant as a UTC dayjs. */
export const nowUtc = (): dayjs.Dayjs => dayjs.utc();

/** Parse any input into a UTC `Date`. */
export const toUtcDate = (input: DateInput): Date => dayjs.utc(input).toDate();

/** Emit an ISO-8601 UTC string. */
export const toIso = (input: DateInput): string => dayjs.utc(input).toISOString();

/**
 * Calendar date (`YYYY-MM-DD`) of an instant, in `tz` (default UTC).
 * Replaces the ad-hoc `d.toISOString().split("T")[0]`.
 */
export const dateOnly = (input: DateInput, tz: string = DEFAULT_TZ): string =>
  dayjs.utc(input).tz(tz).format("YYYY-MM-DD");

// ─── Wall-clock → UTC (firm-timezone interpretation) ──────────────────────────

/**
 * Interpret a wall-clock `dateStr` (`YYYY-MM-DD`) + `time` (`HH:MM` or
 * `HH:MM:SS`) as local time in `tz` and return the corresponding UTC instant.
 * DST-safe. Replaces the hardcoded `` `${dateStr}T${time}Z` `` construction that
 * incorrectly pinned wall-clock times to UTC.
 */
export const wallClockToUtc = (
  dateStr: string,
  time: string,
  tz: string = DEFAULT_TZ,
): Date => {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return dayjs.tz(`${dateStr}T${normalized}`, tz).utc().toDate();
};

/** Same as {@link wallClockToUtc} but returns epoch milliseconds. */
export const wallClockToEpoch = (
  dateStr: string,
  time: string,
  tz: string = DEFAULT_TZ,
): number => wallClockToUtc(dateStr, time, tz).getTime();

/**
 * Day-of-week (0 = Sunday … 6 = Saturday) of a calendar date, evaluated in `tz`.
 * Replaces `date.getUTCDay()` where the firm zone is what matters.
 */
export const weekdayInTz = (dateStr: string, tz: string = DEFAULT_TZ): number =>
  dayjs.tz(dateStr, tz).day();

// ─── Period boundaries (firm-timezone aware) ──────────────────────────────────

/** Start of the day containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const startOfDay = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).startOf("day").utc().toDate();

/** End of the day containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const endOfDay = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).endOf("day").utc().toDate();

/** Start of the week containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const startOfWeek = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).startOf("week").utc().toDate();

/** End of the week containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const endOfWeek = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).endOf("week").utc().toDate();

/** Start of the month containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const startOfMonth = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).startOf("month").utc().toDate();

/** End of the month containing `input`, as a UTC `Date`, evaluated in `tz`. */
export const endOfMonth = (input: DateInput, tz: string = DEFAULT_TZ): Date =>
  dayjs.utc(input).tz(tz).endOf("month").utc().toDate();

// ─── Diffs & arithmetic ───────────────────────────────────────────────────────

/** Whole days between two instants (`b - a`). Replaces manual ms division. */
export const daysBetween = (a: DateInput, b: DateInput): number =>
  dayjs.utc(b).startOf("day").diff(dayjs.utc(a).startOf("day"), "day");

/** Add `amount` of `unit` to an instant, returning a UTC `Date`. */
export const addTime = (
  input: DateInput,
  amount: number,
  unit: dayjs.ManipulateType,
): Date => dayjs.utc(input).add(amount, unit).toDate();

// ─── Presentation (always labeled) ────────────────────────────────────────────

const ZONED_TIME_FMT = "h:mm A";
const ZONED_DATETIME_FMT = "MMM D, YYYY h:mm A";

/**
 * Format an instant in `tz` with an explicit zone abbreviation appended
 * (e.g. "3:00 PM EST"). Used for lead/staff-facing emails, which must always
 * carry a zone label so the recipient can map the time.
 */
export const formatWithZone = (
  input: DateInput,
  tz: string = DEFAULT_TZ,
  fmt: string = ZONED_DATETIME_FMT,
): string => `${dayjs.utc(input).tz(tz).format(fmt)} ${zoneAbbr(input, tz)}`;

/** Time-only variant of {@link formatWithZone} (e.g. "3:00 PM BST"). */
export const formatTimeWithZone = (
  input: DateInput,
  tz: string = DEFAULT_TZ,
): string => formatWithZone(input, tz, ZONED_TIME_FMT);

/**
 * Dual-zone rendering for cross-timezone coordination in emails: the primary
 * (recipient) zone plus the firm zone, both labeled. Collapses to a single
 * value when the two zones resolve to the same offset.
 * e.g. "3:00 PM EST (12:00 PM PST firm time)".
 */
export const formatDualZone = (
  input: DateInput,
  recipientTz: string,
  firmTz: string,
  fmt: string = ZONED_DATETIME_FMT,
): string => {
  const primary = formatWithZone(input, recipientTz, fmt);
  if (dayjs.utc(input).tz(recipientTz).format("Z") ===
      dayjs.utc(input).tz(firmTz).format("Z")) {
    return primary;
  }
  return `${primary} (${formatWithZone(input, firmTz, fmt)} firm time)`;
};

/** Short timezone abbreviation for an instant in `tz` (e.g. "EST", "BST"). */
export const zoneAbbr = (input: DateInput, tz: string = DEFAULT_TZ): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(dayjs.utc(input).toDate());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
};
