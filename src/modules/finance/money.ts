/**
 * Money helpers for the finance module.
 *
 * Columns are numeric(15,4). The four decimals exist to carry *rate* precision
 * through intermediate math — hours x rate, a total divided into instalments —
 * without accumulating rounding drift. Anything a client is actually billed or
 * pays is rounded to 2dp at write time, so line amounts sum exactly and nobody
 * is charged a fraction of a cent.
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
 * Split `amount` across trust/operating, filling TRUST FIRST.
 *
 * Used as the default when a payment is recorded without an explicit split, so
 * the simple Record-payment form keeps working. The result is stored, not
 * recomputed at read time — IOLTA money must be tracked, not estimated.
 *
 * Trust-first rather than pro-rata, for two reasons:
 *
 *   1. **It is what the processor does.** Confido allocates partial payments
 *      trust-first, cumulatively, and it was verified against their sandbox
 *      rather than assumed. Apportioning differently on our side would make our
 *      ledger disagree with theirs on every partial payment.
 *   2. **It is the safer order.** Government and filing fees are the client's
 *      money passing through the firm; funding those before the firm's own fee
 *      means a part-paid matter is never short on the money that is not the
 *      firm's to be short of.
 *
 * Unlike pro-rata there is no remainder to place — one side is filled and the
 * rest goes to the other — so the parts sum exactly to `amount` by
 * construction, which is what `invoice_payments_split_balances` requires.
 *
 * `operatingOutstanding` is unused by this rule but stays in the signature:
 * callers pass both sides, and the day an allocation policy needs the operating
 * figure again (a "costs first" agreement, say) the call sites should not have
 * to change.
 */
export const trustFirstSplit = (
  amount: number,
  operatingOutstanding: number,
  trustOutstanding: number,
): { operating: number; trust: number } => {
  const paid = toMoney(amount);

  // Nothing owed to trust — an overpayment on a settled invoice, or an
  // operating-only one. It is the firm's revenue, not client money.
  if (toMoney(trustOutstanding) <= 0) return { operating: paid, trust: 0 };

  const trust = Math.min(paid, toMoney(trustOutstanding));
  return { operating: toMoney(paid - trust), trust };
};
