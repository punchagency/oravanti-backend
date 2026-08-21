import { z } from "zod";

/**
 * Whether the firm wants credit-card surcharging on.
 *
 * Deliberately only a boolean. The rate is Confido's and not firm-editable, and
 * whether surcharging is permitted at all is Confido's to grant — neither
 * belongs in a request body.
 */
export const setSurchargeSchema = z.object({
  enabled: z.boolean(),
});

export type SetSurchargeBody = z.infer<typeof setSurchargeSchema>;

/**
 * How settled a payment must be before it opens a case.
 *
 * Ours rather than Confido's, unlike surcharging — this is the firm's answer to
 * a trade-off in our own pipeline, so it is a stored choice with a real body.
 */
export const setClearingPolicySchema = z.object({
  policy: z.enum(["on_report", "ach_only", "all_payments"]),
});

export type SetClearingPolicyBody = z.infer<typeof setClearingPolicySchema>;
