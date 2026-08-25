import { z } from "zod";
import { MINIMUM_CONSULTATION_FEE } from "../../../config/constants";
import { isValidTimezone } from "../../../utils/date";

/**
 * The fee structures a firm may choose — a subset of the
 * `consultation_fee_structure` pgEnum, which is the full list and stays so.
 *
 * `waived_if_retainer` is disabled and absent here: it renders a promise to the
 * client — "your fee is waived if you sign within N days" — that no code
 * anywhere keeps. The value stays in the database enum because the feature is
 * deferred rather than abandoned (and Postgres cannot drop an enum value), and
 * `toSettingsDTO` normalises it to `flat` on read, so a firm that had chosen it
 * keeps that on record for whenever it is built.
 *
 * `custom_per_case_type` stays enabled and is live behaviour: it is what lets
 * staff set the amount per consultation (`leads.service.ts`, fee resolution).
 * The NAME is a leftover — it promises a case-type lookup that has never
 * existed, and `practice_area_case_types` carries no money column to build one
 * from. The UI calls it "Set per consultation", which is what it does; the enum
 * value stays because Postgres cannot rename a member in place and the value is
 * not worth a migration on its own.
 */
export const enabledConsultationFeeStructures = [
  "flat",
  "custom_per_case_type",
] as const;

export const consultationFeeSchedules = [
  "full_upfront",
  "partial_upfront",
  "after_consultation",
] as const;

export const consultationBalanceDueModes = ["fixed", "custom"] as const;

export const consultationNoShowPolicies = [
  "forfeit",
  "refund",
  "decide",
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
    feeStructure: z.enum(enabledConsultationFeeStructures).nullish(),
    // Accepted and ignored. The field is still sent by clients that PATCH the
    // whole settings object back (the timezone card does), so rejecting it
    // outright would 400 a save that changes something else entirely. The
    // service writes null regardless.
    waiverWindowDays: z.number().int().positive().nullish(),
    feeSchedule: z.enum(consultationFeeSchedules).optional(),
    upfrontPercent: z.number().int().min(1).max(99).nullish(),
    balanceDueMode: z.enum(consultationBalanceDueModes).nullish(),
    // Days after the consultation. Zero is meaningful — "due on the day" — so
    // the floor is 0, not 1, unlike the deposit percentage.
    balanceDueDays: z.number().int().min(0).max(90).nullish(),
    noShowPolicy: z.enum(consultationNoShowPolicies).optional(),
    timezone: timezoneSchema.optional(),
    language: languageSchema.optional(),
    smsEnabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // Checked before the `chargesFee` early return below: the deposit rules
    // mirror CHECK constraints on the table, and a body that contradicts one
    // should come back as a field error rather than a 500 from Postgres — a
    // non-charging firm included.
    if (val.feeSchedule === "partial_upfront" && val.upfrontPercent == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A deposit percentage is required when the balance is paid after the consultation",
        path: ["upfrontPercent"],
      });
    }

    if ((val.balanceDueMode == null) !== (val.balanceDueDays == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Set both when the balance is due and how it is decided, or neither",
        path: ["balanceDueDays"],
      });
    }

    if (val.balanceDueMode != null && val.feeSchedule !== "partial_upfront") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A balance due date only applies when the firm collects a deposit",
        path: ["balanceDueMode"],
      });
    }

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
