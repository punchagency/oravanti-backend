import { z } from "zod";
import { MINIMUM_CONSULTATION_FEE } from "../../../config/constants";
import { isValidTimezone } from "../../../utils/date";

export const consultationFeeStructures = [
  "flat",
  "custom_per_case_type",
  "waived_if_retainer",
] as const;

/** Reusable IANA timezone validator (e.g. "America/New_York"). */
export const timezoneSchema = z
  .string()
  .refine(isValidTimezone, { message: "Invalid IANA timezone" });

/**
 * BCP-47 language tag, e.g. "en", "fr", "es-MX". Loose by design — the value is
 * a display preference, so an unrecognised-but-well-formed tag should not block
 * saving the rest of a firm's settings.
 */
export const languageSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, {
    message: "Invalid BCP-47 language tag (e.g. \"en\", \"fr\", \"es-MX\")",
  });

export const upsertConsultationSettingsSchema = z
  .object({
    chargesFee: z.boolean(),
    defaultAmount: z.number().min(MINIMUM_CONSULTATION_FEE, `Minimum consultation fee amount is $${MINIMUM_CONSULTATION_FEE}.00`).nullish(),
    feeStructure: z.enum(consultationFeeStructures).nullish(),
    waiverWindowDays: z.number().int().positive().nullish(),
    timezone: timezoneSchema.optional(),
    language: languageSchema.optional(),
    smsEnabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.chargesFee) return;

    if (val.defaultAmount == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A default fee amount is required when charging consultation fees",
        path: ["defaultAmount"],
      });
    }

    if (!val.feeStructure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A fee structure is required when charging consultation fees",
        path: ["feeStructure"],
      });
    }

    if (val.feeStructure === "waived_if_retainer" && val.waiverWindowDays == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A waiver window (in days) is required for the waived-if-retainer structure",
        path: ["waiverWindowDays"],
      });
    }
  });

export type UpsertConsultationSettingsBody = z.infer<
  typeof upsertConsultationSettingsSchema
>;

export const locationIdParamsSchema = z.object({
  locationId: z.string().uuid(),
});

export const createConsultationLocationSchema = z.object({
  label: z.string().min(1),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  notes: z.string().optional(),
});

export const updateConsultationLocationSchema = createConsultationLocationSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });

export type CreateConsultationLocationBody = z.infer<
  typeof createConsultationLocationSchema
>;
export type UpdateConsultationLocationBody = z.infer<
  typeof updateConsultationLocationSchema
>;
