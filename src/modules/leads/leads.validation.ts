import { z } from "zod";
import { MINIMUM_CONSULTATION_FEE } from "../../config/constants";
import { isValidTimezone } from "../../utils/date";
import { phoneSchema } from "../../validation/common.validation";

const uuid = z.string().uuid();
const optionalUuid = z.string().uuid().optional();
const phone = phoneSchema;
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
  phone: phone.optional(),
  // Whether the lead agreed to be contacted by text. Defaults to false when
  // absent: a phone number on file is not permission to text it.
  smsConsent: z.boolean().optional(),
  entityType: z.enum(["individual", "company"]).optional(),
  /**
   * Required. A lead without one cannot be invoiced — `raiseConsultationInvoice`
   * and its fee-agreement twin both return null and swallow it, leaving a
   * consultation gated on a payment with no invoice behind it — is dropped from
   * conversion metrics by an inner join, and cannot be converted to a case
   * (`openCase` refuses it, two stages later and far too late).
   *
   * Optional on UPDATE, where absent means "not being changed". Note that
   * neither is `.nullable()`: null is rejected at this boundary, and the column
   * is NOT NULL behind it.
   */
  practiceAreaId: uuid,
  /**
   * Required on the same terms, and validated against the practice area rather
   * than only for its own existence — the two are independent columns and
   * nothing else stops them disagreeing. `cases.case_type_id` is already NOT
   * NULL, so the lead table was permitting what the cases table forbids.
   */
  caseTypeId: uuid,
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
  phone: phone.optional(),
  // Staff may grant consent, but never revoke an opt-out — an inbound STOP is
  // the recipient's decision, not the firm's. The service enforces that; this
  // only carries the intent.
  smsConsent: z.boolean().optional(),
  /**
   * Optional here means "not being changed", never "clear it". `optionalUuid` is
   * `.optional()` and deliberately not `.nullable()`, so a literal null is
   * refused at this boundary; `diffNamedRef` refuses a falsy value behind it;
   * and the column is NOT NULL behind that. All three, because the first two
   * read as convenience rather than as constraints.
   */
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
  noteContext: z
    .enum(["manual", "consultation", "lead_update", "intake", "system"])
    .optional(),
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
  status: z.enum(["archived", "reviewed", "new"]),
});

export const advanceStageBodySchema = z.object({
  stage: z.enum([
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

export const leadMetricsQuerySchema = z.object({
  period: z.enum(["30d", "90d", "12mo"]).optional(),
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
  context: z
    .enum(["manual", "consultation", "lead_update", "intake", "system"])
    .optional(),
  visibility: z
    .enum(["all_staff", "attorneys_only", "admins_only"])
    .optional(),
  isPinned: z.boolean().optional(),
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
    // Honoured only when the firm's fee structure lets staff set the amount per
    // consultation. Under a flat fee it is ignored — urgency is priced through
    // `isEmergency`/`emergencyMultiplier`, not by overriding the figure.
    feeAmount: z.number().min(MINIMUM_CONSULTATION_FEE, `Minimum consultation fee amount is $${MINIMUM_CONSULTATION_FEE}.00`).optional(),
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
    // Per-consultation override for when the deposit's balance falls due, in
    // days after the call. Honoured only when the firm's balance mode is
    // `custom`; the firm's own figure is the default and the fallback.
    balanceDueDays: z.number().int().min(0).max(90).optional(),
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
    // Payment timing and the auto-questionnaire remain instant-only: both are
    // decisions made with the client in the room.
    if (!val.startNow && (val.paymentTiming || val.autoSendQuestionnaire)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Payment timing and auto-questionnaire options are only allowed for instant consultations",
        path: ["startNow"],
      });
    }
    // The emergency surcharge is not. It is now the only way to charge above a
    // firm's published fee, so an ordinary urgent booking needs it too —
    // `startNow` implies `urgent`, so testing `urgent` covers both.
    if (!val.startNow && !val.urgent && val.isEmergency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "An emergency surcharge only applies to urgent or instant consultations",
        path: ["isEmergency"],
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

export const leadIdParamsSchema = z.object({ leadId: uuid });

/**
 * The firm's intake checklist, sent whole.
 *
 * No `orderIndex` and no step ids: the array's own order is the order, derived
 * per stage server-side, and the save replaces every step. That keeps the editor
 * from having to track indexes it would only get wrong after a drag.
 *
 * `min(1)` because an empty checklist is indistinguishable from a mis-serialized
 * form, and would silently give every future lead an empty pipeline.
 */
export const saveIntakePipelineStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1_000).nullish(),
        pipelineStage: z.enum([
          "lead_inbox",
          "conflict_check",
          "questionnaire",
          "consultation",
          "fee_agreement",
          "case_opening",
        ]),
        isRequired: z.boolean().optional(),
        // Free text, not an enum: firms name their own roles, and the picker
        // matches case-insensitively against role or job title.
        assignableRoles: z.array(z.string().trim().min(1)).max(10).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const paginationQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
});

export const leadDocumentLinkIdParamsSchema = z.object({
  leadId: uuid,
  linkId: uuid,
});

// The lead-task body schemas that used to live here went with the routes they
// validated. A task is created, edited, assigned and reviewed through `/tasks`
// now, whatever it hangs off — see `tasks.validation.ts`.

export const linkDocumentBodySchema = z.object({
  documentId: uuid,
});

export const leadNoteIdParamsSchema = z.object({
  leadId: uuid,
  noteId: uuid,
});

export const createLeadNoteBodySchema = z.object({
  content: z.string().trim().min(1, "Note content is required"),
  type: z
    .enum(["general", "phone_call", "email", "voicemail", "system_log", "pre_consultation", "post_consultation"])
    .optional(),
  context: z
    .enum(["manual", "consultation", "lead_update", "intake", "system"])
    .optional(),
  visibility: z
    .enum(["all_staff", "attorneys_only", "admins_only"])
    .optional(),
  isPinned: z.boolean().optional(),
});

export const updateLeadNoteBodySchema = z.object({
  content: z.string().trim().min(1).optional(),
  type: z
    .enum(["general", "phone_call", "email", "voicemail", "system_log", "pre_consultation", "post_consultation"])
    .optional(),
  visibility: z
    .enum(["all_staff", "attorneys_only", "admins_only"])
    .optional(),
  isPinned: z.boolean().optional(),
});

export const bulkDeleteNotesBodySchema = z.object({
  noteIds: z.array(z.string().uuid()).min(1, "At least one note ID is required"),
});

export const bulkPinNotesBodySchema = z.object({
  noteIds: z.array(z.string().uuid()).min(1, "At least one note ID is required"),
  pinned: z.boolean(),
});

// Public signing page: the opaque token that resolves to a fee agreement.
export const agreementSigningTokenParamsSchema = z.object({
  token: z.string().min(1),
});
