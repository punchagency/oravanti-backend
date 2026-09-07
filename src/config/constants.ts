import type { AccountType } from "../modules/auth/enums";

/**
 * Account types that bypass email verification. These users receive their
 * credentials via the invitation flow and don't need a separate verify step.
 */
export const EMAIL_VERIFICATION_EXEMPT_ACCOUNT_TYPES = new Set<AccountType>([
  "client",
  "staff",
  // Created from the CLI by somebody who already has the database, so the
  // address is verified by the act of seeding it. There is no invitation flow
  // to send them through and no signup form to arrive from.
  "platform_admin",
]);
/** Minimum consultation fee amount in dollars. */
export const MINIMUM_CONSULTATION_FEE = 5;
