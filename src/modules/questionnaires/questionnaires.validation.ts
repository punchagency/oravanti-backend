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
    "repeat_group",
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
  public systemQuestionParamsSchema = z.object({
    id: this.uuidParam,
    sectionId: this.uuidParam,
    questionId: this.uuidParam,
  });
  public caseTypeIdParamsSchema = z.object({ caseTypeId: this.uuidParam });
  public caseIdParamsSchema = z.object({ caseId: this.uuidParam });
  // Sections and questions are edited by id alone — the owning org is matched
  // in the query, so the route needs no case type or case to scope the write.
  public sectionParamsSchema = z.object({ sectionId: this.uuidParam });
  public questionParamsSchema = z.object({ questionId: this.uuidParam });
  public questionnaireIdParamsSchema = z.object({ id: this.uuidParam });
  public questionnaireClientTokenParamsSchema = z.object({ token: z.string().min(1) });
  public eligibleForCaseParamsSchema = z.object({ caseId: this.uuidParam });
  public responseIdParamsSchema = z.object({ responseId: this.uuidParam });
  public sendIdParamsSchema = z.object({ sendId: this.uuidParam });
  public fileIdParamsSchema = z.object({ fileId: this.uuidParam });

  // History is always read through the matter, never by response id: a version
  // belongs to a matter's answer set, and asking for it any other way would let
  // a caller who knows an id read a matter they cannot open.
  public caseVersionParamsSchema = z.object({
    caseId: this.uuidParam,
    versionId: this.uuidParam,
  });
  public caseQuestionParamsSchema = z.object({
    caseId: this.uuidParam,
    questionId: this.uuidParam,
  });
  public caseRevisionParamsSchema = z.object({
    caseId: this.uuidParam,
    revisionId: this.uuidParam,
  });

  // ── Bodies ─────────────────────────────────────────────────────────────────

  public createSystemQuestionnaireBodySchema = z.object({
    caseTypeId: this.uuidParam,
    /** Intake or case. One questionnaire per case type per stage. */
    stage: z.enum(["intake", "case"]).optional(),
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    sections: z.array(this.initialSectionSchema).optional(),
  });

  /**
   * Rewording the questionnaire itself.
   *
   * `caseTypeId` and `stage` are deliberately absent: together they are the
   * questionnaire's identity, so changing either would collide with whatever
   * already occupies the pair rather than move this one.
   */
  public updateSystemQuestionnaireBodySchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  });

  public addSectionBodySchema = z.object({
    title: z.string().min(1, "title is required"),
    description: z.string().nullable().optional(),
    orderIndex: z.number().int().nonnegative().optional(),
  });

  public updateSectionBodySchema = this.addSectionBodySchema.partial();

  // One `sectionId`, because there is one sections table. The section may be a
  // platform one or the firm's own; the caller does not have to say which.
  public addQuestionBodySchema = this.baseQuestionSchema.extend({
    sectionId: this.uuidParam,
  });

  public updateQuestionBodySchema = this.baseQuestionSchema.partial();

  public listResponsesQuerySchema = this.paginationQuerySchema.extend({
    caseTypeId: this.uuidParam.optional(),
  });

  public stageQuerySchema = z.object({
    stage: z.enum(["intake", "case"]).optional(),
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

  // Staff manual upload — responseId comes from the route param.
  public uploadResponseFileStaffBodySchema = z.object({
    questionId: this.uuidParam,
  });

  /**
   * Answers a staff member typed in-house.
   *
   * `value` is unknown for the same reason form field values are: an answer is
   * `jsonb`, so a multi-select is an array and a yes/no a boolean, and
   * narrowing here would make those unrepresentable. An explicit null is
   * meaningful — it clears the answer.
   */
  public saveCaseAnswersBodySchema = z
    .object({
      status: z.enum(["draft", "submitted"]).optional(),
      /**
       * Which section the staff member pressed Save on, recorded on the version
       * so the history reads "Beneficiary details — 6 answers" rather than a
       * bare count. Null for a save that spans sections, such as a restore.
       */
      sectionId: this.uuidParam.nullable().optional(),
      answers: z
        .array(
          z.object({
            questionId: this.uuidParam,
            value: z.unknown(),
          }),
        )
        .max(500),
    })
    .strict();

  /** What the client is asked, and when they are chased about it. */
  public sendCaseQuestionnaireBodySchema = z
    .object({
      /** Omitted or empty sends every section the matter's questionnaire has. */
      sectionIds: z.array(this.uuidParam).optional(),
      autoReminderDays: z.number().int().min(1).max(90).nullable().optional(),
      dueInDays: z.number().int().min(1).max(365).nullable().optional(),
      language: z.string().trim().min(2).max(40).optional(),
      /**
       * Required: the client sees this, and "we sent it again for some reason"
       * is not a message worth sending. Staff pick it in the send dialog.
       */
      reason: z.enum(["new", "correction", "attention"]),
      reasonNote: z.string().trim().max(1000).nullable().optional(),
    })
    .strict();
}
