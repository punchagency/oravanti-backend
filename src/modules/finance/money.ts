/**
 * Money helpers for the finance module.
 *
 * Columns are numeric(15,4). The four decimals exist to carry *rate* precision
 * through intermediate math — hours x rate, pro-rated payment splits — without
 * accumulating rounding drift. Anything a client is actually billed or pays is
 * rounded to 2dp at write time, so line amounts sum exactly and nobody is
 * charged a fraction of a cent.
 *
 * Postgres numeric arrives over the wire as a string. Parse at the edge, format
 * on the way back in; never let a JS float become the stored value directly.
 */

/** numeric column -> number. Null/undefined read as 0. */
export const num = (value: string | number | null | undefined): number => {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** numeric column -> number, preserving null (for "not set" vs "zero"). */
export const numOrNull = (
  value: string | number | null | undefined,
): number | null => {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Round half-up to `dp` places.
 *
 * `Math.round` is half-up for positives but half-*down* for negatives
 * (Math.round(-0.5) === -0). Money can be negative (a credit), so sign is
 * handled explicitly. The epsilon nudge covers the binary-float case where a
 * value like 1.005 is really 1.00499999999999989.
 */
export const round = (value: number, dp: number): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** dp;
  const scaled = value * factor;
  const nudged = scaled + (scaled >= 0 ? Number.EPSILON : -Number.EPSILON) * Math.abs(scaled);
  return (nudged >= 0 ? Math.round(nudged) : -Math.round(-nudged)) / factor;
};

/** What a client is billed or pays: exactly 2dp. */
export const toMoney = (value: number): number => round(value, 2);

/** Intermediate/rate precision: 4dp, matching the column scale. */
export const toRate = (value: number): number => round(value, 4);

/** number -> the string form a numeric column expects. */
export const money = (value: number): string => toMoney(value).toFixed(2);

/** number -> numeric(_,4) string, for rates and unrounded intermediates. */
export const rate = (value: number): string => toRate(value).toFixed(4);

/**
 * Split `amount` across operating/trust in proportion to what the invoice
 * still owes on each side.
 *
 * Used as the DEFAULT when a payment is recorded without an explicit split, so
 * the simple Record-payment form keeps working. The result is then stored, not
 * recomputed at read time — IOLTA money must be tracked, not estimated.
 *
 * The remainder is assigned to operating so the two parts always sum exactly to
 * `amount`; the `invoice_payments_split_balances` check constraint enforces it.
 */
export const proRateSplit = (
  amount: number,
  operatingOutstanding: number,
  trustOutstanding: number,
): { operating: number; trust: number } => {
  const total = toMoney(operatingOutstanding + trustOutstanding);
  const paid = toMoney(amount);

  // Nothing outstanding to apportion against (an overpayment on a settled
  // invoice, say) — attribute to operating, the firm's own revenue.
  if (total <= 0) return { operating: paid, trust: 0 };

  const trust = toMoney((paid * trustOutstanding) / total);
  const clampedTrust = Math.min(Math.max(trust, 0), paid);
  return { operating: toMoney(paid - clampedTrust), trust: clampedTrust };
};
