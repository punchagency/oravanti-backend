import { and, eq, ne, or, sql, isNotNull } from "drizzle-orm";
import { db } from "../../db/client";
import { confidoFirms } from "../../db/schema/confido-firms";
import { invoicePayments } from "../../db/schema/invoice-payments";
import type { SQL } from "drizzle-orm";

/**
 * How settled a payment must be before it opens a case.
 *
 * The spike measured a real card payment sitting at `PENDING` with
 * `canVoid: true, settledOn: null` — so before this existed, a case opened on
 * money that could still be pulled out of the batch. With ACH the window is
 * days long and ends in a possible return, which is not a rare event: R01
 * (insufficient funds) is routine and retryable twice within thirty days.
 *
 * Waiting for everything to clear is safe and slow; opening on report is fast
 * and occasionally wrong. Which trade a firm wants is a firm's decision, so it
 * is a setting rather than a constant.
 */
export const CLEARING_POLICIES = [
  "on_report",
  "ach_only",
  "all_payments",
] as const;

export type ClearingPolicy = (typeof CLEARING_POLICIES)[number];

export const DEFAULT_CLEARING_POLICY: ClearingPolicy = "ach_only";

export const isClearingPolicy = (value: unknown): value is ClearingPolicy =>
  typeof value === "string" &&
  (CLEARING_POLICIES as readonly string[]).includes(value);

/**
 * Confido's high-dollar risk review.
 *
 * A payment that deviates from a firm's normal pattern is held pending
 * documentation and cleared by hand. A USCIS filing fee from a newly onboarded
 * firm is exactly that shape, so this is not a corner case for us. `HELD` means
 * "we are not sure this money is good", which is the one thing a gate should
 * never wave through — so it is excluded under every policy except the one that
 * explicitly asks for no gate at all.
 */
const HELD = "HELD";

/**
 * The firm's policy, defaulting when it has no Confido row.
 *
 * A firm that never onboarded takes only hand-recorded payments, and those
 * settle at insert under every policy — so the default is never load-bearing
 * for them. It matters from the moment they connect a processor.
 */
export const clearingPolicyFor = async (
  organizationId: string,
): Promise<ClearingPolicy> => {
  const [row] = await db
    .select({ policy: confidoFirms.paymentClearingPolicy })
    .from(confidoFirms)
    .where(eq(confidoFirms.organizationId, organizationId))
    .limit(1);

  return isClearingPolicy(row?.policy) ? row.policy : DEFAULT_CLEARING_POLICY;
};

/**
 * The predicate deciding whether a ledger row counts toward opening a case.
 *
 * Written as SQL rather than filtered in JS so the gate stays one query, and so
 * `agingOverDues` and friends can compose with it later.
 *
 * Reversals need no special case under any policy: they are negative and always
 * carry `settled_at`, so they reduce the counted total everywhere, which is the
 * conservative direction and the correct one.
 *
 *   on_report     every row counts, including money still in flight
 *   ach_only      a card counts immediately; ACH must have cleared. HELD never
 *                 counts, whichever rail it arrived on
 *   all_payments  only cleared money counts
 */
export const countsTowardCaseOpening = (policy: ClearingPolicy): SQL => {
  const settled = isNotNull(invoicePayments.settledAt);

  if (policy === "on_report") return sql`true`;
  if (policy === "all_payments") return settled;

  // ach_only. `method` is ours and reliable — the webhook maps Confido's
  // `achPayment` onto `bank_transfer` — whereas `provider_status` is theirs and
  // may be null on a hand-entered row, which is why the HELD test is written to
  // exclude rather than to require.
  return or(
    settled,
    and(
      ne(invoicePayments.method, "bank_transfer"),
      or(
        sql`${invoicePayments.providerStatus} is null`,
        ne(invoicePayments.providerStatus, HELD),
      ),
    ),
  )!;
};
