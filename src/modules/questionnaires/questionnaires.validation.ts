import { z } from "zod";

export class QuestionnairesValidation {
  private uuidParam = z.string().uuid("Must be a valid UUID");
  private optionalNullableUuid = this.uuidParam.optional().nullable();

  private paginationQuerySchema = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
  });

  public questionTypeSchema = z.enum([
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
  ]);

  private jsonObjectSchema = z.record(z.string(), z.unknown());

  private baseQuestionSchema = z.object({
    label: z.string().min(1, "Question label is required"),
    description: z.string().nullable().optional(),
    type: this.questionTypeSchema,
    orderIndex: z.number().int().nonnegative().optional(),
    isRequired: z.boolean().optional(),
    config: this.jsonObjectSchema.optional(),
  });

  private initialSectionSchema = z.object({
    title: z.string().min(1, "Section title is required"),
    description: z.string().nullable().optional(),
    questions: z.array(this.baseQuestionSchema).optional(),
  });

  // ── Params ─────────────────────────────────────────────────────────────────

  public systemQuestionnaireIdParamsSchema = z.object({ id: this.uuidParam });
  public systemSectionParamsSchema = z.object({ id: this.uuidParam, sectionId: this.uuidParam });
  public systemQuestionParamsSchema = z.object({ id: this.uuidParam, sectionId: this.uuidParam });
  public caseTypeIdParamsSchema = z.object({ caseTypeId: this.uuidParam });
  public firmSectionParamsSchema = z.object({ caseTypeId: this.uuidParam, sectionId: this.uuidParam });
  public firmQuestionParamsSchema = z.object({ caseTypeId: this.uuidParam, questionId: this.uuidParam });
  public questionnaireIdParamsSchema = z.object({ id: this.uuidParam });
  public questionnaireClientTokenParamsSchema = z.object({ token: z.string().min(1) });
  public eligibleForCaseParamsSchema = z.object({ caseId: this.uuidParam });
  public responseIdParamsSchema = z.object({ responseId: this.uuidParam });
  public sendIdParamsSchema = z.object({ sendId: this.uuidParam });

  // ── Bodies ─────────────────────────────────────────────────────────────────

  public createSystemQuestionnaireBodySchema = z.object({
    caseTypeId: this.uuidParam,
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    sections: z.array(this.initialSectionSchema).optional(),
  });

  public addSectionBodySchema = z.object({
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    orderIndex: z.number().int().nonnegative().optional(),
  });

  public addFirmQuestionBodySchema = this.baseQuestionSchema.extend({
    systemSectionId: this.optionalNullableUuid,
    firmSectionId: this.optionalNullableUuid,
  });

  public updateFirmQuestionBodySchema = this.baseQuestionSchema.partial();

  public listResponsesQuerySchema = this.paginationQuerySchema.extend({
    caseTypeId: this.uuidParam.optional(),
  });

  private sectionRefSchema = z.object({
    source: z.enum(["system", "firm"]),
    id: this.uuidParam,
  });

  private answerSchema = z.object({
    questionId: this.uuidParam,
    value: z.unknown(),
  });

  public responseBodySchema = z.object({
    currentSectionRef: this.sectionRefSchema.nullable().optional(),
    answers: z.array(this.answerSchema).optional(),
  });

  public uploadResponseFileBodySchema = z.object({
    responseId: this.uuidParam,
    questionId: this.uuidParam,
    questionSource: z.enum(["system", "firm"]).optional(),
  });
}
