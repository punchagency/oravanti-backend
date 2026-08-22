/**
 * Confido's firm lifecycle, and what it means to us.
 *
 * Two vocabularies deliberately kept apart: Confido's `FirmStatus`, which is
 * theirs to change, and our `PaymentAccountState`, which is what the UI renders.
 * The mapping lives here so the frontend never re-implements the policy and a
 * new Confido status cannot silently become a new UI branch.
 */

/** Confido's documented values, plus two the docs omit. */
export const CONFIDO_FIRM_STATUSES = [
  "CREATED",
  "APP_IN_DRAFT",
  "APP_SUBMITTED",
  "APP_IN_REVIEW",
  "ACTIVE",
  "DECLINED",
  "INACTIVE",
  "SUSPENDED",
] as const;

export type ConfidoFirmStatus = (typeof CONFIDO_FIRM_STATUSES)[number];

/**
 * A status we have never seen is stored and surfaced verbatim rather than
 * coerced. Confido added `DECLINED` in January 2026 without notice, so the set
 * demonstrably grows; mapping an unknown value onto a known one would be a
 * guess, and the guess that costs most is guessing "active".
 */
export const isKnownFirmStatus = (value: string): value is ConfidoFirmStatus =>
  (CONFIDO_FIRM_STATUSES as readonly string[]).includes(value);

/** Uppercases and trims, so casing drift on their side does not read as unknown. */
export const normalizeFirmStatus = (value: string | null | undefined): string =>
  (value ?? "").trim().toUpperCase();

export type PaymentAccountState =
  | "not_configured"
  | "not_started"
  | "provisioning"
  | "application_needed"
  | "application_in_progress"
  | "under_review"
  | "active"
  | "declined"
  | "suspended"
  | "inactive"
  | "token_unreadable"
  | "unknown";

const STATE_BY_STATUS: Record<ConfidoFirmStatus, PaymentAccountState> = {
  CREATED: "application_needed",
  APP_IN_DRAFT: "application_in_progress",
  APP_SUBMITTED: "under_review",
  APP_IN_REVIEW: "under_review",
  ACTIVE: "active",
  DECLINED: "declined",
  INACTIVE: "inactive",
  SUSPENDED: "suspended",
};

export const stateForStatus = (status: string): PaymentAccountState => {
  const normalized = normalizeFirmStatus(status);
  return isKnownFirmStatus(normalized) ? STATE_BY_STATUS[normalized] : "unknown";
};

/**
 * Whether the firm can actually take money.
 *
 * Both conditions, not either. The spike found `createFirm` returning a payload
 * where `status` and `isAcceptingPayments` disagreed, so they are stored
 * separately and read together: `status` is the narrative, `isAcceptingPayments`
 * is Confido's operational flag. Slice 2's payment paths gate on this function
 * and nothing else.
 */
export const canAcceptPayments = (
  status: string,
  isAcceptingPayments: boolean,
): boolean => normalizeFirmStatus(status) === "ACTIVE" && isAcceptingPayments;

/**
 * A state the firm cannot move out of by trying again.
 *
 * `DECLINED` is terminal by Confido's own documentation — underwriting has
 * already asked for follow-up and not received it. Offering a retry button that
 * cannot work is worse than an honest dead end, so the UI asks this rather than
 * assuming every non-active state is recoverable.
 */
export const isTerminalState = (state: PaymentAccountState): boolean =>
  state === "declined";
