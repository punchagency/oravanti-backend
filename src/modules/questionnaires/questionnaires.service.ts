import { createHash, randomBytes } from "crypto";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { supabaseAdmin } from "../../config/supabase";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import {
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  caseTypeQuestionnaireQuestions,
  caseTypeQuestionnaireLogicRules,
  firmQuestionnaireSections,
  firmQuestionnaireQuestions,
  questionnaireAnswers,
  questionnaireResponseFiles,
  questionnaireResponses,
  questionnaireSends,
} from "../../db/schema/questionnaires";
import {
  BadRequestError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";

const { SUPABASE_STORAGE_BUCKET } = env;

type JsonObject = Record<string, unknown>;
type AnswerInput = { questionId: string; value: unknown };

type QuestionInput = {
  label: string;
  description?: string | null;
  type:
    | "short_text" | "long_text" | "number" | "email" | "phone"
    | "date" | "time" | "single_choice" | "multiple_choice" | "dropdown"
    | "rating_scale" | "file_upload" | "yes_no" | "matrix_grid" | "signature";
  isRequired?: boolean;
  config?: JsonObject;
};

type SectionInput = {
  title: string;
  description?: string | null;
  questions?: QuestionInput[];
};

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const generateAccessToken = () => randomBytes(32).toString("base64url");

const isEmptyAnswer = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
};

const buildResponseFileStoragePath = (
  organizationId: string,
  responseId: string,
  questionId: string,
  filename: string,
) => `questionnaire-responses/${organizationId}/${responseId}/${questionId}/${filename}`;

const getQuestionSourceFromSnapshot = (
  snapshot: unknown,
  questionId: string,
): "system" | "firm" => {
  if (!snapshot || typeof snapshot !== "object") return "system";
  const s = snapshot as {
    sections?: Array<{ questions?: Array<{ id: string; source?: string }> }>;
  };
  for (const section of s.sections ?? []) {
    for (const q of section.questions ?? []) {
      if (q.id === questionId) return (q.source as "system" | "firm") ?? "system";
    }
  }
  return "system";
};

const validateSubmissionAnswers = (snapshot: unknown, answers: AnswerInput[]) => {
  if (!snapshot || typeof snapshot !== "object") return;
  const s = snapshot as {
    sections?: Array<{ questions?: Array<{ id: string; isRequired?: boolean }> }>;
  };
  const allQuestions = (s.sections ?? []).flatMap((sec) => sec.questions ?? []);
  const answerMap = new Map(answers.map((a) => [a.questionId, a.value]));
  const missing = allQuestions
    .filter((q) => q.isRequired)
    .filter((q) => isEmptyAnswer(answerMap.get(q.id)));

  if (missing.length) {
    throw new BadRequestError("Required answers are missing", {
      questionIds: missing.map((q) => q.id),
    });
  }
};

export class QuestionnairesService {
  // ── System Questionnaire Read ──────────────────────────────────────────────

  getSystemQuestionnaires = async () => {
    return db.select().from(caseTypeQuestionnaires).orderBy(asc(caseTypeQuestionnaires.createdAt));
  };

  getSystemQuestionnaireByCaseType = async (caseTypeId: string) => {
    const [questionnaire] = await db
      .select()
      .from(caseTypeQuestionnaires)
      .where(eq(caseTypeQuestionnaires.caseTypeId, caseTypeId))
      .limit(1);

    if (!questionnaire) return null;
    return this.buildSystemQuestionnaireStructure(questionnaire.id);
  };

  getSystemQuestionnaireById = async (id: string) => {
    const [questionnaire] = await db
      .select()
      .from(caseTypeQuestionnaires)
      .where(eq(caseTypeQuestionnaires.id, id))
      .limit(1);

    if (!questionnaire) return null;
    return this.buildSystemQuestionnaireStructure(id);
  };

  // ── System Questionnaire Management (platform admin) ─────────────────────

  createSystemQuestionnaire = async (data: {
    caseTypeId: string;
    title: string;
    description?: string | null;
    sections?: SectionInput[];
  }) => {
    return db.transaction(async (tx) => {
      const [ct] = await tx
        .select()
        .from(practiceAreaCaseTypes)
        .where(eq(practiceAreaCaseTypes.id, data.caseTypeId))
        .limit(1);
      if (!ct) throw new BadRequestError("Case type not found");

      const [existing] = await tx
        .select()
        .from(caseTypeQuestionnaires)
        .where(eq(caseTypeQuestionnaires.caseTypeId, data.caseTypeId))
        .limit(1);
      if (existing) {
        throw new ConflictError("A questionnaire already exists for this case type");
      }

      const [questionnaire] = await tx
        .insert(caseTypeQuestionnaires)
        .values({ caseTypeId: data.caseTypeId, title: data.title, description: data.description })
        .returning();

      for (const [i, section] of (data.sections ?? []).entries()) {
        const [s] = await tx
          .insert(caseTypeQuestionnaireSections)
          .values({
            questionnaireId: questionnaire.id,
            title: section.title,
            description: section.description,
            orderIndex: i,
          })
          .returning();

        for (const [j, question] of (section.questions ?? []).entries()) {
          await tx.insert(caseTypeQuestionnaireQuestions).values({
            questionnaireId: questionnaire.id,
            sectionId: s.id,
            label: question.label,
            description: question.description,
            type: question.type,
            orderIndex: j,
            isRequired: question.isRequired ?? false,
            config: (question.config ?? {}) as any,
          });
        }
      }

      return this.buildSystemQuestionnaireStructure(questionnaire.id, tx);
    });
  };

  addSystemSection = async (
    questionnaireId: string,
    data: { title: string; description?: string | null; orderIndex?: number },
  ) => {
    const orderIndex =
      data.orderIndex ??
      (await this.getNextSectionOrderIndex(caseTypeQuestionnaireSections, questionnaireId));

    const [created] = await db
      .insert(caseTypeQuestionnaireSections)
      .values({ questionnaireId, title: data.title, description: data.description, orderIndex })
      .returning();

    return created;
  };

  addSystemQuestion = async (
    questionnaireId: string,
    sectionId: string,
    data: QuestionInput & { orderIndex?: number },
  ) => {
    const orderIndex =
      data.orderIndex ??
      (await this.getNextQuestionOrderIndex(
        caseTypeQuestionnaireQuestions,
        questionnaireId,
        sectionId,
      ));

    const [created] = await db
      .insert(caseTypeQuestionnaireQuestions)
      .values({
        questionnaireId,
        sectionId,
        label: data.label,
        description: data.description,
        type: data.type,
        orderIndex,
        isRequired: data.isRequired ?? false,
        config: (data.config ?? {}) as any,
      })
      .returning();

    return created;
  };

  // ── Firm Questionnaire Additions ────────────────────────────────────────────

  getMergedQuestionnaire = async (organizationId: string, caseTypeId: string) => {
    const systemQ = await this.getSystemQuestionnaireByCaseType(caseTypeId);

    const firmSections = await db
      .select()
      .from(firmQuestionnaireSections)
      .where(
        and(
          eq(firmQuestionnaireSections.organizationId, organizationId),
          eq(firmQuestionnaireSections.caseTypeId, caseTypeId),
        ),
      )
      .orderBy(asc(firmQuestionnaireSections.orderIndex));

    const firmQuestions = await db
      .select()
      .from(firmQuestionnaireQuestions)
      .where(
        and(
          eq(firmQuestionnaireQuestions.organizationId, organizationId),
          eq(firmQuestionnaireQuestions.caseTypeId, caseTypeId),
        ),
      )
      .orderBy(asc(firmQuestionnaireQuestions.orderIndex));

    const systemSections = (systemQ?.sections ?? []).map((section: any) => ({
      ...section,
      source: "system" as const,
      questions: [
        ...section.questions.map((q: any) => ({ ...q, source: "system" as const, isLocked: true })),
        ...firmQuestions
          .filter((fq) => fq.systemSectionId === section.id)
          .map((fq) => ({ ...fq, source: "firm" as const, isLocked: false })),
      ],
    }));

    const appendedFirmSections = firmSections.map((fs) => ({
      ...fs,
      source: "firm" as const,
      questions: firmQuestions
        .filter((fq) => fq.firmSectionId === fs.id)
        .map((fq) => ({ ...fq, source: "firm" as const, isLocked: false })),
    }));

    return {
      systemQuestionnaire: systemQ,
      sections: [...systemSections, ...appendedFirmSections],
    };
  };

  addFirmSection = async (
    organizationId: string,
    caseTypeId: string,
    data: { title: string; description?: string | null; orderIndex?: number },
  ) => {
    await this.ensureCaseTypeExists(caseTypeId);

    const orderIndex =
      data.orderIndex ?? (await this.getNextFirmSectionOrderIndex(organizationId, caseTypeId));

    const [created] = await db
      .insert(firmQuestionnaireSections)
      .values({ organizationId, caseTypeId, title: data.title, description: data.description, orderIndex })
      .returning();

    return created;
  };

  updateFirmSection = async (
    organizationId: string,
    sectionId: string,
    data: { title?: string; description?: string | null; orderIndex?: number },
  ) => {
    const [updated] = await db
      .update(firmQuestionnaireSections)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(firmQuestionnaireSections.id, sectionId),
          eq(firmQuestionnaireSections.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError("Section not found");
    return updated;
  };

  deleteFirmSection = async (organizationId: string, sectionId: string) => {
    await db
      .delete(firmQuestionnaireQuestions)
      .where(
        and(
          eq(firmQuestionnaireQuestions.firmSectionId, sectionId),
          eq(firmQuestionnaireQuestions.organizationId, organizationId),
        ),
      );

    await db
      .delete(firmQuestionnaireSections)
      .where(
        and(
          eq(firmQuestionnaireSections.id, sectionId),
          eq(firmQuestionnaireSections.organizationId, organizationId),
        ),
      );
  };

  addFirmQuestion = async (
    organizationId: string,
    caseTypeId: string,
    data: QuestionInput & {
      systemSectionId?: string | null;
      firmSectionId?: string | null;
      orderIndex?: number;
    },
  ) => {
    if (!data.systemSectionId && !data.firmSectionId) {
      throw new BadRequestError("Either systemSectionId or firmSectionId must be provided");
    }

    const orderIndex =
      data.orderIndex ??
      (await this.getNextFirmQuestionOrderIndex(
        organizationId,
        caseTypeId,
        data.systemSectionId ?? null,
        data.firmSectionId ?? null,
      ));

    const [created] = await db
      .insert(firmQuestionnaireQuestions)
      .values({
        organizationId,
        caseTypeId,
        systemSectionId: data.systemSectionId ?? undefined,
        firmSectionId: data.firmSectionId ?? undefined,
        label: data.label,
        description: data.description,
        type: data.type,
        orderIndex,
        isRequired: data.isRequired ?? false,
        config: (data.config ?? {}) as any,
      })
      .returning();

    return created;
  };

  updateFirmQuestion = async (
    organizationId: string,
    questionId: string,
    data: Partial<QuestionInput>,
  ) => {
    const [updated] = await db
      .update(firmQuestionnaireQuestions)
      .set({ ...data, config: data.config as any, updatedAt: new Date() })
      .where(
        and(
          eq(firmQuestionnaireQuestions.id, questionId),
          eq(firmQuestionnaireQuestions.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundError("Question not found");
    return updated;
  };

  deleteFirmQuestion = async (organizationId: string, questionId: string) => {
    await db
      .delete(firmQuestionnaireQuestions)
      .where(
        and(
          eq(firmQuestionnaireQuestions.id, questionId),
          eq(firmQuestionnaireQuestions.organizationId, organizationId),
        ),
      );
  };

  // ── Responses ─────────────────────────────────────────────────────────────

  getResponses = async (
    organizationId: string,
    caseTypeQuestionnaireId: string,
    filters: Partial<PaginationParams> & { caseTypeId?: string } = {},
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });
    const conditions = [
      eq(questionnaireResponses.organizationId, organizationId),
      eq(questionnaireResponses.caseTypeQuestionnaireId, caseTypeQuestionnaireId),
    ];

    if (filters.caseTypeId) {
      conditions.push(eq(questionnaireResponses.caseTypeId, filters.caseTypeId));
    }

    const where = and(...conditions);
    const [{ total }] = await db
      .select({ total: count() })
      .from(questionnaireResponses)
      .where(where);

    const rows = await db
      .select()
      .from(questionnaireResponses)
      .where(where)
      .orderBy(desc(questionnaireResponses.createdAt))
      .limit(limit)
      .offset(offset);

    return buildPaginatedResponse(rows, { page, limit, total: Number(total) });
  };

  getEligibleQuestionnairesForCase = async (organizationId: string, caseId: string) => {
    const [caseRow] = await db
      .select()
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!caseRow) throw new NotFoundError("Case not found");
    if (!caseRow.caseTypeId) return null;

    return this.getSystemQuestionnaireByCaseType(caseRow.caseTypeId);
  };

  // ── Token-Based Client Flow ────────────────────────────────────────────────

  getClientQuestionnaireByToken = async (accessToken: string) => {
    const send = await this.getActiveSendByToken(accessToken, true);
    const response = await this.getResponseForSend(send.id);

    return {
      send,
      questionnaire: send.schemaSnapshot,
      response,
    };
  };

  saveDraftResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionRef?: { source: string; id: string } | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    return this.saveResponse(send, {
      status: "draft",
      currentSectionRef: data.currentSectionRef,
      answers: data.answers ?? [],
    });
  };

  submitResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionRef?: { source: string; id: string } | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    return this.saveResponse(send, {
      status: "submitted",
      currentSectionRef: data.currentSectionRef,
      answers: data.answers ?? [],
    });
  };

  uploadResponseFileByToken = async (
    accessToken: string,
    data: {
      responseId: string;
      questionId: string;
      questionSource?: "system" | "firm";
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    const response = await this.ensureResponseForSend(data.responseId, send.id, send.organizationId);

    if (response.status === "submitted") {
      throw new ConflictError("Submitted responses cannot be changed");
    }

    const questionSource =
      data.questionSource ?? getQuestionSourceFromSnapshot(send.schemaSnapshot, data.questionId);

    const safeFilename = `${Date.now()}-${data.originalFilename.replace(/\s+/g, "_")}`;
    const storagePath = buildResponseFileStoragePath(
      send.organizationId,
      response.id,
      data.questionId,
      safeFilename,
    );

    const { error: uploadError } = await supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(storagePath, data.fileBuffer, { contentType: data.mimeType, upsert: false });

    if (uploadError) throw new ExternalServiceError(uploadError.message);

    const { data: urlData } = supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    const [file] = await db
      .insert(questionnaireResponseFiles)
      .values({
        organizationId: send.organizationId,
        responseId: response.id,
        questionId: data.questionId,
        questionSource,
        storagePath,
        fileUrl: urlData.publicUrl,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        originalFilename: data.originalFilename,
      })
      .returning();

    return file;
  };

  // ── Private Helpers ────────────────────────────────────────────────────────

  private buildSystemQuestionnaireStructure = async (id: string, database: any = db) => {
    const [questionnaire] = await database
      .select()
      .from(caseTypeQuestionnaires)
      .where(eq(caseTypeQuestionnaires.id, id))
      .limit(1);

    if (!questionnaire) return null;

    const sections = await database
      .select()
      .from(caseTypeQuestionnaireSections)
      .where(eq(caseTypeQuestionnaireSections.questionnaireId, id))
      .orderBy(asc(caseTypeQuestionnaireSections.orderIndex));

    const questions = await database
      .select()
      .from(caseTypeQuestionnaireQuestions)
      .where(eq(caseTypeQuestionnaireQuestions.questionnaireId, id))
      .orderBy(asc(caseTypeQuestionnaireQuestions.orderIndex));

    const logicRules = await database
      .select()
      .from(caseTypeQuestionnaireLogicRules)
      .where(eq(caseTypeQuestionnaireLogicRules.questionnaireId, id))
      .orderBy(asc(caseTypeQuestionnaireLogicRules.priority));

    const questionsBySection = new Map<string, (typeof questions)[number][]>();
    for (const q of questions) {
      const arr = questionsBySection.get(q.sectionId) ?? [];
      arr.push(q);
      questionsBySection.set(q.sectionId, arr);
    }

    return {
      ...questionnaire,
      sections: sections.map((s: any) => ({
        ...s,
        questions: questionsBySection.get(s.id) ?? [],
      })),
      logicRules,
    };
  };

  private ensureCaseTypeExists = async (caseTypeId: string, database: any = db) => {
    const [ct] = await database
      .select()
      .from(practiceAreaCaseTypes)
      .where(eq(practiceAreaCaseTypes.id, caseTypeId))
      .limit(1);
    if (!ct) throw new BadRequestError("Case type not found");
    return ct;
  };

  private getNextSectionOrderIndex = async (table: any, questionnaireId: string, database: any = db) => {
    const [{ total }] = await database
      .select({ total: count() })
      .from(table)
      .where(eq(table.questionnaireId, questionnaireId));
    return Number(total);
  };

  private getNextQuestionOrderIndex = async (
    table: any,
    questionnaireId: string,
    sectionId: string,
    database: any = db,
  ) => {
    const [{ total }] = await database
      .select({ total: count() })
      .from(table)
      .where(and(eq(table.questionnaireId, questionnaireId), eq(table.sectionId, sectionId)));
    return Number(total);
  };

  private getNextFirmSectionOrderIndex = async (
    organizationId: string,
    caseTypeId: string,
    database: any = db,
  ) => {
    const [{ total }] = await database
      .select({ total: count() })
      .from(firmQuestionnaireSections)
      .where(
        and(
          eq(firmQuestionnaireSections.organizationId, organizationId),
          eq(firmQuestionnaireSections.caseTypeId, caseTypeId),
        ),
      );
    return Number(total);
  };

  private getNextFirmQuestionOrderIndex = async (
    organizationId: string,
    caseTypeId: string,
    systemSectionId: string | null,
    firmSectionId: string | null,
    database: any = db,
  ) => {
    const conditions: any[] = [
      eq(firmQuestionnaireQuestions.organizationId, organizationId),
      eq(firmQuestionnaireQuestions.caseTypeId, caseTypeId),
    ];
    if (systemSectionId) conditions.push(eq(firmQuestionnaireQuestions.systemSectionId, systemSectionId));
    if (firmSectionId) conditions.push(eq(firmQuestionnaireQuestions.firmSectionId, firmSectionId));

    const [{ total }] = await database
      .select({ total: count() })
      .from(firmQuestionnaireQuestions)
      .where(and(...conditions));

    return Number(total);
  };

  private getActiveSendByToken = async (accessToken: string, markOpened = false) => {
    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.accessTokenHash, tokenHash(accessToken)))
      .limit(1);

    if (!send) throw new NotFoundError("Questionnaire send not found");
    if (send.status === "revoked") throw new ConflictError("Questionnaire send has been revoked");
    if (send.expiresAt && send.expiresAt.getTime() < Date.now()) {
      await db
        .update(questionnaireSends)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(questionnaireSends.id, send.id));
      throw new ConflictError("Questionnaire send has expired");
    }

    if (markOpened && send.status === "sent") {
      const [updated] = await db
        .update(questionnaireSends)
        .set({ status: "opened", openedAt: new Date(), updatedAt: new Date() })
        .where(eq(questionnaireSends.id, send.id))
        .returning();
      return updated;
    }

    return send;
  };

  private getResponseForSend = async (sendId: string, database: any = db) => {
    const [response] = await database
      .select()
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.questionnaireSendId, sendId))
      .limit(1);

    if (!response) return null;

    const answers = await database
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));

    const files = await database
      .select()
      .from(questionnaireResponseFiles)
      .where(eq(questionnaireResponseFiles.responseId, response.id));

    return { ...response, answers, files };
  };

  private ensureResponseForSend = async (
    responseId: string,
    sendId: string,
    organizationId: string,
    database: any = db,
  ) => {
    const [response] = await database
      .select()
      .from(questionnaireResponses)
      .where(
        and(
          eq(questionnaireResponses.id, responseId),
          eq(questionnaireResponses.questionnaireSendId, sendId),
          eq(questionnaireResponses.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!response) throw new NotFoundError("Response not found");
    return response;
  };

  private saveResponse = async (
    send: typeof questionnaireSends.$inferSelect,
    data: {
      status: "draft" | "submitted";
      currentSectionRef?: { source: string; id: string } | null;
      answers: AnswerInput[];
    },
  ) => {
    return db.transaction(async (tx) => {
      const existing = await this.getResponseForSend(send.id, tx);
      if (existing?.status === "submitted") {
        throw new ConflictError("Client has already submitted a response");
      }

      // Merge answers: existing base + incoming updates
      const answerMap = new Map<string, { value: unknown; source: "system" | "firm" }>();
      for (const answer of existing?.answers ?? []) {
        answerMap.set(answer.questionId, {
          value: answer.value,
          source: answer.questionSource as "system" | "firm",
        });
      }
      for (const answer of data.answers) {
        const source = getQuestionSourceFromSnapshot(send.schemaSnapshot, answer.questionId);
        answerMap.set(answer.questionId, { value: answer.value, source });
      }

      const mergedAnswers = Array.from(answerMap.entries()).map(([questionId, a]) => ({
        questionId,
        value: a.value,
      }));

      if (data.status === "submitted") {
        validateSubmissionAnswers(send.schemaSnapshot, mergedAnswers);
      }

      const now = new Date();
      const [response] = existing
        ? await tx
            .update(questionnaireResponses)
            .set({
              status: data.status,
              currentSectionRef: data.currentSectionRef as any,
              lastSavedAt: now,
              submittedAt: data.status === "submitted" ? now : null,
              updatedAt: now,
            })
            .where(eq(questionnaireResponses.id, existing.id))
            .returning()
        : await tx
            .insert(questionnaireResponses)
            .values({
              organizationId: send.organizationId,
              questionnaireSendId: send.id,
              caseTypeQuestionnaireId: send.caseTypeQuestionnaireId,
              leadId: send.leadId,
              clientId: send.clientId,
              caseId: send.caseId,
              caseTypeId: send.caseTypeId,
              status: data.status,
              currentSectionRef: data.currentSectionRef as any,
              lastSavedAt: now,
              submittedAt: data.status === "submitted" ? now : null,
            })
            .returning();

      for (const [questionId, { value, source }] of answerMap.entries()) {
        await tx
          .insert(questionnaireAnswers)
          .values({ responseId: response.id, questionId, questionSource: source, value: value as any })
          .onConflictDoUpdate({
            target: [questionnaireAnswers.responseId, questionnaireAnswers.questionId],
            set: { value: value as any, updatedAt: now },
          });
      }

      await tx
        .update(questionnaireSends)
        .set({
          status: data.status === "submitted" ? "submitted" : "draft_response",
          submittedAt: data.status === "submitted" ? now : null,
          updatedAt: now,
        })
        .where(eq(questionnaireSends.id, send.id));

      return this.getResponseForSend(send.id, tx);
    });
  };
}
