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
