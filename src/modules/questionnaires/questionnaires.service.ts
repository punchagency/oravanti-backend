import { createHash, randomBytes } from "crypto";
import PDFDocument from "pdfkit";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { formatWithZone } from "../../utils/date";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";
import { cases } from "../../db/schema/cases";
import { conflictChecks } from "../../db/schema/conflict-checks";
import { leads, leadsToCaseTypes } from "../../db/schema/leads";
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
  cancelQuestionnaireReminder,
  enqueueDocumentScan,
} from "../../queue/queues";
import { sendQuestionnaireReminder } from "../../queue/workers/reminder.worker";
import { emailService } from "../../utils/email/email.service";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  PaginationParams,
} from "../../utils/pagination";
import { storageService } from "../../utils/storage/storage.service";

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

/**
 * Response files store the storage object key (not a permanent URL). Replace
 * each `fileUrl` with a short-lived presigned download URL for client responses.
 */
const presignResponseFiles = <T extends { storagePath: string }>(files: T[]) =>
  Promise.all(
    files.map(async (file) => ({
      ...file,
      fileUrl: await storageService.getSignedDownloadUrl(file.storagePath),
    })),
  );

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

const computeCompletion = (
  snapshot: unknown,
  answers: { questionId: string; value: unknown }[],
  files: { questionId: string }[],
) => {
  if (!snapshot || typeof snapshot !== "object") {
    return { answered: 0, total: 0 };
  }
  const s = snapshot as {
    sections?: Array<{ questions?: Array<{ id: string }> }>;
  };
  const allQuestions = (s.sections ?? []).flatMap((sec) => sec.questions ?? []);
  const answeredIds = new Set<string>();
  for (const a of answers) {
    if (!isEmptyAnswer(a.value)) answeredIds.add(a.questionId);
  }
  for (const f of files) answeredIds.add(f.questionId);
  const answered = allQuestions.filter((q) => answeredIds.has(q.id)).length;
  return { answered, total: allQuestions.length };
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
    const result = await this.saveResponse(send, {
      status: "submitted",
      currentSectionRef: data.currentSectionRef,
      answers: data.answers ?? [],
    });

    // Response is in — cancel the pending auto-reminder so it never fires.
    if (send.reminderJobId) {
      await cancelQuestionnaireReminder(send.reminderJobId).catch(console.error);
    }

    return result;
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

    await storageService.upload({
      key: storagePath,
      body: data.fileBuffer,
      contentType: data.mimeType,
    });

    const [file] = await db
      .insert(questionnaireResponseFiles)
      .values({
        organizationId: send.organizationId,
        responseId: response.id,
        leadId: send.leadId,
        questionId: data.questionId,
        questionSource,
        storagePath,
        fileUrl: storagePath,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        originalFilename: data.originalFilename,
      })
      .returning();

    // Kick off the (stubbed) AI document scan asynchronously.
    await enqueueDocumentScan(file.id).catch(console.error);

    return file;
  };

  /**
   * Staff-side manual upload of a document received outside the client portal
   * (e.g. in-person, by email, or via scan). Attaches the file to the response's
   * question so the consultation card reflects it as received.
   */
  uploadResponseFileByStaff = async (
    organizationId: string,
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
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(
        and(
          eq(questionnaireResponses.id, data.responseId),
          eq(questionnaireResponses.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!response) throw new NotFoundError("Response not found");

    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.id, response.questionnaireSendId))
      .limit(1);

    const questionSource =
      data.questionSource ??
      getQuestionSourceFromSnapshot(send?.schemaSnapshot, data.questionId);

    const safeFilename = `${Date.now()}-${data.originalFilename.replace(/\s+/g, "_")}`;
    const storagePath = buildResponseFileStoragePath(
      organizationId,
      response.id,
      data.questionId,
      safeFilename,
    );

    await storageService.upload({
      key: storagePath,
      body: data.fileBuffer,
      contentType: data.mimeType,
    });

    const [file] = await db
      .insert(questionnaireResponseFiles)
      .values({
        organizationId,
        responseId: response.id,
        leadId: send?.leadId ?? null,
        questionId: data.questionId,
        questionSource,
        storagePath,
        fileUrl: storagePath,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        originalFilename: data.originalFilename,
      })
      .returning();

    await enqueueDocumentScan(file.id).catch(console.error);

    return file;
  };

  /**
   * Get all questionnaire response files linked to a lead.
   * Used by the lead documents tab to show files collected during intake.
   */
  getFilesByLeadId = async (leadId: string) => {
    const files = await db
      .select()
      .from(questionnaireResponseFiles)
      .where(eq(questionnaireResponseFiles.leadId, leadId))
      .orderBy(desc(questionnaireResponseFiles.createdAt));

    return presignResponseFiles(files);
  };

  // ── Intake: eligible leads, question bank, response review ──────────────────

  /**
   * Leads that are ready to receive a questionnaire: in the questionnaire stage,
   * conflict-cleared, with a case type, and not yet sent one. Shaped for the send
   * wizard's "<name> — <case type>" dropdown.
   */
  getEligibleLeadsForQuestionnaire = async (organizationId: string) => {
    const rows = await db
      .select({
        id: leads.id,
        firstName: leads.firstName,
        lastName: leads.lastName,
        email: leads.email,
        caseTypeId: leadsToCaseTypes.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        conflictStatus: conflictChecks.status,
        supervisorOverrideById: conflictChecks.supervisorOverrideById,
      })
      .from(leads)
      .leftJoin(leadsToCaseTypes, eq(leadsToCaseTypes.leadId, leads.id))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, leadsToCaseTypes.caseTypeId),
      )
      .leftJoin(conflictChecks, eq(conflictChecks.id, leads.conflictCheckId))
      .where(
        and(
          eq(leads.organizationId, organizationId),
          eq(leads.pipelineStage, "questionnaire"),
          isNull(leads.questionnaireSendId),
        ),
      );

    return rows
      .filter((r) => r.caseTypeId)
      .filter(
        (r) =>
          r.conflictStatus === "pass" ||
          r.conflictStatus === null || // no conflict check on file
          r.supervisorOverrideById !== null,
      )
      .map((r) => ({
        id: r.id,
        name: `${r.firstName} ${r.lastName}`,
        email: r.email,
        caseTypeId: r.caseTypeId,
        caseTypeName: r.caseTypeName,
      }));
  };

  /**
   * System question library grouped by case type, for the wizard's "browse
   * snippets" picker.
   */
  getQuestionBank = async () => {
    const rows = await db
      .select({
        caseTypeId: caseTypeQuestionnaires.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        questionnaireTitle: caseTypeQuestionnaires.title,
        questionLabel: caseTypeQuestionnaireQuestions.label,
        questionType: caseTypeQuestionnaireQuestions.type,
        questionDescription: caseTypeQuestionnaireQuestions.description,
        orderIndex: caseTypeQuestionnaireQuestions.orderIndex,
      })
      .from(caseTypeQuestionnaireQuestions)
      .innerJoin(
        caseTypeQuestionnaires,
        eq(
          caseTypeQuestionnaires.id,
          caseTypeQuestionnaireQuestions.questionnaireId,
        ),
      )
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, caseTypeQuestionnaires.caseTypeId),
      )
      .orderBy(asc(caseTypeQuestionnaireQuestions.orderIndex));

    const grouped = new Map<
      string,
      {
        caseTypeId: string;
        caseTypeName: string | null;
        questions: { label: string; type: string; description: string | null }[];
      }
    >();
    for (const r of rows) {
      const key = r.caseTypeId;
      const entry = grouped.get(key) ?? {
        caseTypeId: r.caseTypeId,
        caseTypeName: r.caseTypeName,
        questions: [],
      };
      entry.questions.push({
        label: r.questionLabel,
        type: r.questionType,
        description: r.questionDescription,
      });
      grouped.set(key, entry);
    }
    return Array.from(grouped.values());
  };

  /**
   * Full response detail for the admin review modal: send (with snapshot),
   * response, answers, files (incl. scan results) and a completion summary.
   */
  getResponseDetailById = async (organizationId: string, responseId: string) => {
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(
        and(
          eq(questionnaireResponses.id, responseId),
          eq(questionnaireResponses.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!response) throw new NotFoundError("Response not found");

    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.id, response.questionnaireSendId))
      .limit(1);

    const answers = await db
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));

    const files = await db
      .select()
      .from(questionnaireResponseFiles)
      .where(eq(questionnaireResponseFiles.responseId, response.id));

    const completion = computeCompletion(send?.schemaSnapshot, answers, files);

    return {
      response,
      send,
      answers,
      files: await presignResponseFiles(files),
      completion,
    };
  };

  /**
   * Mark a response complete and advance its lead to the consultation stage.
   * Requires every required question/document to be answered.
   */
  acceptResponseAndAdvance = async (
    organizationId: string,
    responseId: string,
  ) => {
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(
        and(
          eq(questionnaireResponses.id, responseId),
          eq(questionnaireResponses.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!response) throw new NotFoundError("Response not found");

    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.id, response.questionnaireSendId))
      .limit(1);

    const answers = await db
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));
    const files = await db
      .select()
      .from(questionnaireResponseFiles)
      .where(eq(questionnaireResponseFiles.responseId, response.id));

    // File-upload questions are "answered" by an uploaded file.
    const merged = [
      ...answers.map((a) => ({ questionId: a.questionId, value: a.value })),
      ...files.map((f) => ({ questionId: f.questionId, value: "file" })),
    ];
    validateSubmissionAnswers(send?.schemaSnapshot, merged);

    if (response.leadId) {
      await db
        .update(leads)
        .set({ pipelineStage: "consultation", updatedAt: new Date() })
        .where(eq(leads.id, response.leadId));
    }

    return { advanced: true, leadId: response.leadId };
  };

  /**
   * Render the response answers to a PDF (documents excluded). Returns a Buffer.
   */
  generateResponsePdf = async (
    organizationId: string,
    responseId: string,
  ): Promise<{ buffer: Buffer; filename: string }> => {
    const { response, send, answers } = await this.getResponseDetailById(
      organizationId,
      responseId,
    );

    // The PDF is a firm-facing document; render timestamps in the firm zone.
    const tz = await getFirmTimezone(organizationId);
    const answerMap = new Map(answers.map((a) => [a.questionId, a.value]));
    const snapshot = (send?.schemaSnapshot ?? {}) as {
      title?: string;
      sections?: Array<{
        title?: string;
        questions?: Array<{ id: string; label: string; type: string }>;
      }>;
    };

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    doc
      .fontSize(18)
      .text(snapshot.title ?? "Questionnaire response", { underline: false });
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(`Status: ${response.status}`)
      .text(
        `Submitted: ${response.submittedAt ? formatWithZone(response.submittedAt, tz) : "—"}`,
      )
      .moveDown(1)
      .fillColor("#000");

    for (const section of snapshot.sections ?? []) {
      doc.moveDown(0.5).fontSize(13).fillColor("#1a1a1a").text(section.title ?? "Section");
      doc.moveDown(0.25);
      for (const q of section.questions ?? []) {
        if (q.type === "file_upload") continue; // documents excluded from PDF
        const raw = answerMap.get(q.id);
        const value =
          raw == null || (typeof raw === "string" && raw.trim() === "")
            ? "Not yet answered"
            : typeof raw === "string"
              ? raw
              : JSON.stringify(raw);
        doc.fontSize(10).fillColor("#444").text(q.label, { continued: false });
        doc.fontSize(11).fillColor("#000").text(value).moveDown(0.4);
      }
    }

    doc.end();
    const buffer = await done;
    return { buffer, filename: `questionnaire-response-${responseId}.pdf` };
  };

  /**
   * Fetch an uploaded response document for a gated download (proxied from
   * storage so access can be permission-checked rather than relying on the
   * public URL). Caller must have the documents:download permission.
   */
  getResponseFileForDownload = async (
    organizationId: string,
    fileId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> => {
    const [file] = await db
      .select()
      .from(questionnaireResponseFiles)
      .where(
        and(
          eq(questionnaireResponseFiles.id, fileId),
          eq(questionnaireResponseFiles.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!file) throw new NotFoundError("Document not found");

    const buffer = await storageService.download(file.storagePath);
    return {
      buffer,
      mimeType: file.mimeType,
      filename: file.originalFilename,
    };
  };

  /** Manually send a reminder for an outstanding questionnaire send. */
  sendManualReminder = async (organizationId: string, sendId: string) => {
    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(
        and(
          eq(questionnaireSends.id, sendId),
          eq(questionnaireSends.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!send) throw new NotFoundError("Questionnaire send not found");

    const sent = await sendQuestionnaireReminder(sendId);
    if (!sent) {
      throw new BadRequestError(
        "No reminder sent — the questionnaire is already submitted.",
      );
    }
    return { reminderSentAt: new Date() };
  };

  /**
   * Email the lead a targeted list of the documents they still owe — the
   * file_upload questions in the send's snapshot that have no uploaded file.
   * Returns the missing document labels; sends nothing when none are missing.
   */
  requestMissingDocuments = async (organizationId: string, sendId: string) => {
    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(
        and(
          eq(questionnaireSends.id, sendId),
          eq(questionnaireSends.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!send) throw new NotFoundError("Questionnaire send not found");

    const snapshot = (send.schemaSnapshot ?? {}) as {
      sections?: Array<{
        questions?: Array<{ id: string; label: string; type: string }>;
      }>;
    };
    const fileQuestions = (snapshot.sections ?? []).flatMap(
      (section) =>
        section.questions?.filter((q) => q.type === "file_upload") ?? [],
    );

    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.questionnaireSendId, sendId))
      .limit(1);

    const uploadedQuestionIds = new Set<string>();
    if (response) {
      const files = await db
        .select({ questionId: questionnaireResponseFiles.questionId })
        .from(questionnaireResponseFiles)
        .where(eq(questionnaireResponseFiles.responseId, response.id));
      for (const f of files) uploadedQuestionIds.add(f.questionId);
    }

    const missingQuestions = fileQuestions.filter(
      (q) => !uploadedQuestionIds.has(q.id),
    );
    const missing = missingQuestions.map((q) => q.label);

    if (missing.length === 0) return { missing };

    if (send.leadId) {
      const [lead] = await db
        .select()
        .from(leads)
        .where(eq(leads.id, send.leadId))
        .limit(1);
      if (lead) {
        emailService
          .sendEmail({
            to: lead.email,
            subject: "Outstanding documents for your intake",
            html: `<p>Dear ${lead.firstName},</p>
              <p>To continue with your intake, we still need the following document(s):</p>
              <ul>${missing.map((label) => `<li>${label}</li>`).join("")}</ul>
              <p>Please upload them using your intake questionnaire link. If you have
              misplaced your link, please contact your attorney's office.</p>`,
          })
          .catch(console.error);

        const channels = (send.deliveryChannels as string[] | null) ?? [];
        if (channels.includes("sms") && lead.phone) {
          console.log(
            `[sms-stub] missing-documents request to ${lead.phone} for send ${sendId}`,
          );
        }
      }
    }

    return { missing };
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

    return { ...response, answers, files: await presignResponseFiles(files) };
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
