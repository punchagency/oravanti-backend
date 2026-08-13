import type { AccountType } from "../modules/auth/enums";

/**
 * Account types that bypass email verification. These users receive their
 * credentials via the invitation flow and don't need a separate verify step.
 */
export const EMAIL_VERIFICATION_EXEMPT_ACCOUNT_TYPES = new Set<AccountType>([
  "client",
  "staff",
]);
