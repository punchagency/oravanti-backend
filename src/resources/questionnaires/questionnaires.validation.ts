import { z } from "zod";

export class QuestionnairesValidation {
  private uuidParam = z.string().uuid("Must be a valid UUID");
  private optionalNullableUuid = this.uuidParam.optional().nullable();

  private paginationQuerySchema = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
  });

  public questionnaireStatusSchema = z.enum([
    "draft",
    "published",
    "archived",
  ]);

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

  public logicActionTypeSchema = z.enum([
    "show_question",
    "hide_question",
    "skip_to_question",
    "skip_to_section",
    "require_question",
    "branch_to_section",
    "end_questionnaire",
  ]);

  private jsonObjectSchema = z.record(z.string(), z.unknown());

  private questionOptionSchema = z.object({
    label: z.string().min(1, "Option label is required"),
    value: z.string().min(1, "Option value is required"),
    orderIndex: z.number().int().nonnegative().optional(),
  });

  private baseQuestionSchema = z.object({
    label: z.string().min(1, "Question label is required"),
    description: z.string().nullable().optional(),
    type: this.questionTypeSchema,
    orderIndex: z.number().int().nonnegative().optional(),
    isRequired: z.boolean().optional(),
    config: this.jsonObjectSchema.optional(),
    options: z.array(this.questionOptionSchema).optional(),
  });

  private questionWithSectionSchema = this.baseQuestionSchema.extend({
    sectionId: this.uuidParam,
  });

  private initialSectionSchema = z.object({
    title: z.string().min(1, "Section title is required"),
    description: z.string().nullable().optional(),
    orderIndex: z.number().int().nonnegative().optional(),
    questions: z.array(this.baseQuestionSchema).optional(),
  });

  private reorderItemSchema = z.object({
    id: this.uuidParam,
    orderIndex: z.number().int().nonnegative(),
    sectionId: this.uuidParam.optional(),
  });

  public questionnaireIdParamsSchema = z.object({
    id: this.uuidParam,
  });

  public questionnaireQuestionParamsSchema = z.object({
    id: this.uuidParam,
    questionId: this.uuidParam,
  });

  public questionnaireClientTokenParamsSchema = z.object({
    token: z.string().min(1, "token is required"),
  });

  public eligibleForCaseParamsSchema = z.object({
    caseId: this.uuidParam,
  });

  public listQuestionnairesQuerySchema = this.paginationQuerySchema.extend({
    search: z.string().optional(),
    status: this.questionnaireStatusSchema.optional(),
    caseTypeId: this.uuidParam.optional(),
  });

  public createQuestionnaireBodySchema = z.object({
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    firstSectionTitle: z.string().min(1).optional(),
    caseTypeIds: z.array(this.uuidParam).optional(),
    sections: z.array(this.initialSectionSchema).optional(),
  });

  public updateQuestionnaireBodySchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: this.questionnaireStatusSchema.optional(),
    caseTypeIds: z.array(this.uuidParam).optional(),
  });

  public duplicateQuestionnaireBodySchema = z
    .object({
      title: z.string().min(1).optional(),
    })
    .default({});

  public setQuestionnaireCaseTypesBodySchema = z.object({
    caseTypeIds: z.array(this.uuidParam),
  });

  public addSectionBodySchema = z.object({
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    orderIndex: z.number().int().nonnegative().optional(),
  });

  public reorderItemsBodySchema = z.object({
    items: z.array(this.reorderItemSchema),
  });

  public addQuestionBodySchema = this.questionWithSectionSchema;

  public updateQuestionBodySchema = this.baseQuestionSchema.partial().extend({
    sectionId: this.uuidParam.optional(),
  });

  public addLogicRuleBodySchema = z.object({
    sourceQuestionId: this.optionalNullableUuid,
    condition: this.jsonObjectSchema,
    actionType: this.logicActionTypeSchema,
    action: this.jsonObjectSchema,
    priority: z.number().int().optional(),
  });

  public sendQuestionnaireBodySchema = z.object({
    clientId: this.uuidParam,
    caseTypeId: this.uuidParam,
    caseId: this.optionalNullableUuid,
    expiresAt: z.coerce.date().optional().nullable(),
  });

  public listResponsesQuerySchema = this.paginationQuerySchema.extend({
    caseTypeId: this.uuidParam.optional(),
  });

  private answerSchema = z.object({
    questionId: this.uuidParam,
    value: z.unknown(),
  });

  public responseBodySchema = z.object({
    currentSectionId: this.optionalNullableUuid,
    answers: z.array(this.answerSchema).optional(),
  });

  public uploadResponseFileBodySchema = z.object({
    responseId: this.uuidParam,
    questionId: this.uuidParam,
  });
}
