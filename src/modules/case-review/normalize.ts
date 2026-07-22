/**
 * Value normalization for issue fingerprinting.
 *
 * The content hash must be stable across cosmetic differences in extracted
 * values — otherwise a rerun mints a phantom "changed" issue and loses an
 * attorney's resolution. Dates in different formats, names with different
 * diacritics/casing/whitespace must all normalize to one canonical form.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Canonical text form: strip diacritics (NFKD + drop combining marks),
 * lowercase, collapse whitespace. "José  GARCÍA" and "jose garcia" → "jose garcia".
 */
export const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const MONTH_NAME = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/**
 * Whether a string plausibly denotes a date. Gates date parsing so bare numbers
 * ("2020", "12" — a year, a document number) aren't silently treated as dates.
 */
const isDateLike = (s: string): boolean => {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true; // ISO
  if (MONTH_NAME.test(s) && /\b\d{4}\b/.test(s)) return true; // "12 March 1990"
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(s)) return true; // 12/03/1990
  return false;
};

/**
 * Normalize a date-ish string to ISO `YYYY-MM-DD`, or null if it isn't a date.
 *
 * ISO strings are handled by string-slicing rather than `new Date()` to avoid
 * the UTC-midnight-shifts-a-day-in-local-time trap. Other formats parse via
 * `Date` and use local calendar components (also shift-safe).
 *
 * Numeric `DD/MM/YYYY` vs `MM/DD/YYYY` is genuinely ambiguous; parsing is
 * consistent per input, so the risk is a false "changed" (surfacing a possibly
 * spurious issue), never a false merge (hiding a real change).
 */
export const normalizeDate = (value: string): string | null => {
  const s = value.trim();
  if (!isDateLike(s)) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/**
 * Canonicalize a single salient value for hashing: dates → ISO, everything else
 * → canonical text. Null/undefined → empty string.
 */
export const normalizeValue = (
  value: string | number | null | undefined,
): string => {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return normalizeDate(s) ?? normalizeText(s);
};

/**
 * Parse a date-ish string to a `Date` (UTC midnight), or null. Built on
 * `normalizeDate` so parsing is consistent with fingerprinting. Used by the
 * deadline rules for comparisons.
 */
export const parseDate = (value: string): Date | null => {
  const iso = normalizeDate(value);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
