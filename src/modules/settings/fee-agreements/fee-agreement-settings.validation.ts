import { z } from "zod";

export const feeAgreementSigningOrders = ["client_first", "firm_first"] as const;

/**
 * Every field is optional, and the service applies each one only when it is
 * present. That is deliberate and load-bearing: the settings tab saves one card
 * at a time, and a defaulted field here would let the card that knows nothing
 * about counter-signing silently switch it off. `consultation_settings` learned
 * this the hard way with its SMS master switch.
 */
export const upsertFeeAgreementSettingsSchema = z.object({
  requiresFirmSignature: z.boolean().optional(),
  signingOrder: z.enum(feeAgreementSigningOrders).optional(),
  invoiceWaitsForFirmSignature: z.boolean().optional(),
  allowSignerOverride: z.boolean().optional(),
  // Explicitly nullable: clearing the fallback signer is a real choice, and it
  // falls back to the organization owner.
  defaultSignerStaffId: z.string().uuid().nullable().optional(),
});

export type UpsertFeeAgreementSettingsBody = z.infer<
  typeof upsertFeeAgreementSettingsSchema
>;
