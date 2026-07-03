import { z } from "zod";

const uuid = z.string().uuid();
const optionalUuid = z.string().uuid().optional();

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
  name: z.string().min(1),
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
});

export const updateLeadBodySchema = z.object({
  name: z.string().min(1).optional(),
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

// Admin initiates scheduling. Normally the lead later picks the time; for
// urgent bookings the admin supplies scheduledAt and the lead skips the queue.
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
    // Urgent (admin fast-track): schedule now, skip the lead's slot queue.
    urgent: z.boolean().optional(),
    scheduledAt: z.string().datetime().optional(),
    // Set when this consultation is a follow-up of a prior completed one.
    parentConsultationId: optionalUuid,
  })
  .superRefine((val, ctx) => {
    if (val.mode === "in_person" && !val.locationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A location is required for in-person consultations",
        path: ["locationId"],
      });
    }
    if (val.urgent && !val.scheduledAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A time is required for urgent scheduling",
        path: ["scheduledAt"],
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
});

export const cancelConsultationBodySchema = z.object({
  reason: z.string().max(1000).optional(),
});

export const generateFeeAgreementBodySchema = z.object({
  agreementType: z.string().optional(),
  generatedFrom: z.enum(["questionnaire_auto", "manual"]).optional(),
});

export const openCaseBodySchema = z.object({
  assignedStaffId: optionalUuid,
  teamId: optionalUuid,
  notes: z.string().optional(),
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

export const esignatureWebhookBodySchema = z.object({
  envelopeId: z.string().min(1),
  status: z.string().min(1),
  signedAt: z.string().optional(),
  signedBy: z.string().optional(),
});
