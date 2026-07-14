import { z } from "zod";
import { isValidTimezone } from "../../utils/date";

const uuid = z.string().uuid();
const optionalUuid = z.string().uuid().optional();
const timezone = z
  .string()
  .refine(isValidTimezone, { message: "Invalid IANA timezone" });

export const idParamsSchema = z.object({ id: uuid });

export const caseIdParamsSchema = z.object({ caseId: uuid });

export const caseIdStepIdParamsSchema = z.object({
  caseId: uuid,
  stepId: uuid,
});

export const adversePartyParamsSchema = z.object({
  caseId: uuid,
  partyId: uuid,
});

export const agreementIdParamsSchema = z.object({ agreementId: uuid });

export const createLeadBodySchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  entityType: z.enum(["individual", "company"]).optional(),
  practiceAreaId: optionalUuid,
  caseTypeId: optionalUuid,
  source: z.enum([
    "education_flywheel",
    "referral",
    "direct",
    "walk_in",
    "phone_enquiry",
    "client_portal",
  ]),
  situationSummary: z.string().optional(),
  notes: z.string().optional(),
  assignedStaffId: optionalUuid,
  intakeAdversePartyName: z.string().min(1).optional(),
  intakeAdversePartyEmail: z.string().email().optional(),
  timezone: timezone.optional(),
  language: z.string().min(1).optional(),
});

export const updateLeadBodySchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  practiceAreaId: optionalUuid,
  caseTypeId: optionalUuid,
  source: z
    .enum([
      "education_flywheel",
      "referral",
      "direct",
      "walk_in",
      "phone_enquiry",
      "client_portal",
    ])
    .optional(),
  situationSummary: z.string().optional(),
  notes: z.string().optional(),
  assignedStaffId: optionalUuid,
  intakeAdversePartyName: z.string().min(1).optional(),
  intakeAdversePartyEmail: z.string().email().optional(),
  timezone: timezone.optional(),
  language: z.string().min(1).optional(),
});

// Public (booking-page) reconciliation of the lead's timezone.
export const updateBookingTimezoneBodySchema = z.object({
  timezone,
});

export const updateLeadStatusSchema = z.object({
  status: z.enum(["archived", "reviewed"]),
});

export const advanceStageBodySchema = z.object({
  stage: z.enum([
    "lead_inbox",
    "conflict_check",
    "questionnaire",
    "consultation",
    "fee_agreement",
    "case_opening",
  ]),
});

export const archiveLeadBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});

// Notes are append-only, so there is deliberately no update schema to pair
// with this one.
export const addLeadNoteBodySchema = z.object({
  type: z
    .enum([
      "general",
      "phone_call",
      "email",
      "voicemail",
      "system_log",
      "pre_consultation",
      "post_consultation",
    ])
    .optional(),
  content: z.string().trim().min(1, "A note cannot be empty").max(10_000),
});

export const resolveConflictCheckBodySchema = z.object({
  action: z.enum(["approve", "decline"]),
  reviewNotes: z
    .string()
    .trim()
    .min(1, "A note is required to resolve a conflict"),
});

const questionnaireQuestionTypeValues = [
  "short_text",
  "long_text",
  "number",
  "email",
  "phone",
  "date",
  "time",
  "single_choice",
  "multiple_choice",
  "dropdown",
  "rating_scale",
  "file_upload",
  "yes_no",
  "matrix_grid",
  "signature",
] as const;

export const sendQuestionnaireBodySchema = z.object({
  deliveryChannels: z.array(z.enum(["email", "sms"])).optional(),
  language: z.string().optional(),
  // null/omitted = never; otherwise one of the allowed reminder intervals
  autoReminderDays: z
    .union([z.literal(2), z.literal(3), z.literal(5), z.literal(7)])
    .nullable()
    .optional(),
  customQuestions: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        type: z.enum(questionnaireQuestionTypeValues).optional(),
        isRequired: z.boolean().optional(),
        saveToFirm: z.boolean().optional(),
      }),
    )
    .optional(),
  customDocumentRequests: z
    .array(
      z.object({
        label: z.string().trim().min(1),
        isRequired: z.boolean().optional(),
        saveToFirm: z.boolean().optional(),
      }),
    )
    .optional(),
});

// Admin initiates scheduling. Normally the lead later picks the time; urgent
// bookings skip the queue and are auto-scheduled ASAP server-side (at payment
// time when a fee applies, immediately otherwise).
export const initiateConsultationBodySchema = z
  .object({
    leadAttorneyId: uuid,
    participantStaffIds: z.array(uuid).optional(),
    mode: z.enum(["video", "in_person", "phone_call"]),
    duration: z.number().int().positive(),
    locationId: optionalUuid,
    // Used when the firm's fee structure is custom_per_case_type, or as an
    // urgency surcharge/override when urgent.
    feeAmount: z.number().positive().optional(),
    preConsultationNotes: z.string().optional(),
    notifyChannels: z.array(z.enum(["email", "sms"])).optional(),
    // Urgent (admin fast-track): auto-scheduled ASAP, skips the slot queue.
    urgent: z.boolean().optional(),
    // Set when this consultation is a follow-up of a prior completed one.
    parentConsultationId: optionalUuid,
    // Instant consultation: begins now (or at payment time for pay_now).
    startNow: z.boolean().optional(),
    paymentTiming: z
      .enum(["pay_now", "invoice_after", "pay_in_person"])
      .optional(),
    isEmergency: z.boolean().optional(),
    emergencyMultiplier: z.number().positive().max(10).optional(),
    autoSendQuestionnaire: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "in_person" && !val.locationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A location is required for in-person consultations",
        path: ["locationId"],
      });
    }
    if (val.startNow && !val.paymentTiming) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a payment timing for instant consultations",
        path: ["paymentTiming"],
      });
    }
    if (
      !val.startNow &&
      (val.paymentTiming || val.isEmergency || val.autoSendQuestionnaire)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Payment timing, emergency, and auto-questionnaire options are only allowed for instant consultations",
        path: ["startNow"],
      });
    }
    if (val.emergencyMultiplier != null && !val.isEmergency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An emergency multiplier requires the consultation to be marked as an emergency",
        path: ["emergencyMultiplier"],
      });
    }
  });

export const bookingTokenParamsSchema = z.object({
  token: z.string().min(1),
});

export const selectSlotBodySchema = z.object({
  start: z.string().datetime(),
});

export const updateConsultationBodySchema = z.object({
  scheduledAt: z.string().datetime().optional(),
  duration: z.number().int().positive().optional(),
  mode: z.enum(["video", "in_person", "phone_call"]).optional(),
  videoLink: z.string().url().optional().nullable(),
  status: z
    .enum(["scheduled", "in_progress", "completed", "cancelled", "no_show"])
    .optional(),
  preConsultationNotes: z.string().optional(),
  attorneyNotes: z.string().optional(),
  outcome: z
    .enum(["proceed", "close_no_case", "refer_elsewhere", "follow_up"])
    .optional(),
  // Staff marks a pay-in-person fee as received (only valid from unpaid).
  feeStatus: z.enum(["paid"]).optional(),
});

export const cancelConsultationBodySchema = z.object({
  reason: z.string().max(1000).optional(),
});

// Date-only strings ("YYYY-MM-DD") — kept as plain strings end to end so the
// document renderers never do timezone math on them.
const dateOnlyString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Expected a YYYY-MM-DD date",
});

export const generateFeeAgreementBodySchema = z
  .object({
    agreementType: z.string().optional(),
    generatedFrom: z.enum(["questionnaire_auto", "manual"]).optional(),
    attorneyFee: z
      .object({
        type: z.enum(["flat", "hourly", "flat_hourly", "contingency"]),
        flatRate: z.number().nonnegative().optional(),
        hourlyRate: z.number().nonnegative().optional(),
        estimatedHours: z.number().positive().optional(),
        // Settlement percentage, combinable with any type; required for
        // pure-contingency agreements.
        contingencyPercent: z.number().positive().max(100).optional(),
      })
      .superRefine((val, ctx) => {
        if (
          (val.type === "flat" || val.type === "flat_hourly") &&
          val.flatRate == null
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A flat rate is required",
            path: ["flatRate"],
          });
        if (
          (val.type === "hourly" || val.type === "flat_hourly") &&
          val.hourlyRate == null
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "An hourly rate is required",
            path: ["hourlyRate"],
          });
        if (val.type === "contingency" && val.contingencyPercent == null)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A settlement percentage is required",
            path: ["contingencyPercent"],
          });
      }),
    // Required for contingency agreements; abaConfirmed is the wire flag that
    // the attorney checked all three ABA 1.5(c) boxes — the service stamps
    // the timestamp server-side.
    contingencyTerms: z
      .object({
        coversCaseCosts: z.boolean(),
        coversExpertWitnessFees: z.boolean(),
        ifLost: z.enum(["client_owes_nothing", "client_reimburses_hard_costs"]),
        abaConfirmed: z.literal(true),
      })
      .optional(),
    governmentFees: z
      .array(
        z.object({
          name: z.string().min(1),
          amount: z.number().nonnegative(),
        }),
      )
      .default([]),
    otherCosts: z
      .array(
        z.object({
          name: z.string().min(1),
          amount: z.number().nonnegative(),
        }),
      )
      .default([]),
    governmentFeesPaidBy: z
      .enum(["client_upfront", "firm_advanced"])
      .default("client_upfront"),
    // Optional so the form can omit them when nothing is due upfront.
    paymentPlan: z
      .enum(["pay_in_full", "two_payments", "installments"])
      .default("pay_in_full"),
    twoPaymentsSchedule: z
      .object({
        firstAmount: z.number().positive(),
        secondAmount: z.number().positive(),
        secondDueDate: dateOnlyString,
      })
      .optional(),
    installmentSchedule: z
      .object({
        monthlyAmount: z.number().positive(),
        numberOfPayments: z.number().int().min(1).max(120),
        firstPaymentDate: dateOnlyString,
      })
      .optional(),
    paymentAllocation: z
      .object({
        order: z.enum(["fees_first", "costs_first", "custom"]),
        customFeePercent: z.number().positive().lt(100).optional(),
      })
      .optional(),
    applyConsultationCredit: z.boolean().default(false),
    accountSplit: z
      .object({
        operating: z.number().nonnegative(),
        trust: z.number().nonnegative(),
      })
      .default({ operating: 0, trust: 0 }),
  })
  .superRefine((val, ctx) => {
    if (val.attorneyFee.type === "contingency" && !val.contingencyTerms)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Contingency terms are required for contingency agreements",
        path: ["contingencyTerms"],
      });
    // One-directional: a chosen plan requires its schedule; a stray schedule
    // sent with another plan is simply ignored at persist time.
    if (val.paymentPlan === "two_payments" && !val.twoPaymentsSchedule)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A two-payment schedule is required",
        path: ["twoPaymentsSchedule"],
      });
    if (val.paymentPlan === "installments" && !val.installmentSchedule)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An installment schedule is required",
        path: ["installmentSchedule"],
      });
    if (
      val.paymentAllocation?.order === "custom" &&
      val.paymentAllocation.customFeePercent == null
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A custom split percentage is required",
        path: ["paymentAllocation", "customFeePercent"],
      });
  });

export const openCaseBodySchema = z.object({
  assignedTeamId: z.string().optional(),
});

export const updateWorkflowStepBodySchema = z.object({
  status: z.enum(["pending", "in_progress", "completed", "skipped"]).optional(),
  completedById: optionalUuid,
  notes: z.string().optional(),
  dueDate: z.string().optional(),
});

export const addAdversePartyBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  entityType: z.enum(["individual", "company"]).optional(),
  relationship: z.enum([
    "opposing_party",
    "opposing_counsel",
    "witness",
    "other",
  ]),
  notes: z.string().optional(),
});

export const updateAdversePartyBodySchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  entityType: z.enum(["individual", "company"]).optional(),
  relationship: z
    .enum(["opposing_party", "opposing_counsel", "witness", "other"])
    .optional(),
  notes: z.string().optional(),
});

// Public signing page: the opaque token that resolves to a fee agreement.
export const agreementSigningTokenParamsSchema = z.object({
  token: z.string().min(1),
});
