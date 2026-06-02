import { createHash, randomBytes } from "crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  max,
  or,
} from "drizzle-orm";
import { supabaseAdmin } from "../../config/supabase";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import {
  questionnaireAnswers,
  questionnaireCaseTypes,
  questionnaireLogicRules,
  questionnaireQuestionOptions,
  questionnaireQuestions,
  questionnaireResponseFiles,
  questionnaireResponses,
  questionnaireSections,
  questionnaireSends,
  questionnaireVersionCaseTypes,
  questionnaireVersions,
  questionnaires,
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
type AnswerInput = {
  questionId: string;
  value: unknown;
};

type QuestionOptionInput = {
  label: string;
  value: string;
  orderIndex?: number;
};

type QuestionInput = {
  sectionId: string;
  label: string;
  description?: string | null;
  type:
    | "short_text"
    | "long_text"
    | "number"
    | "email"
    | "phone"
    | "date"
    | "time"
    | "single_choice"
    | "multiple_choice"
    | "dropdown"
    | "rating_scale"
    | "file_upload"
    | "yes_no"
    | "matrix_grid"
    | "signature";
  orderIndex?: number;
  isRequired?: boolean;
  config?: JsonObject;
  options?: QuestionOptionInput[];
};

type ReorderItem = {
  id: string;
  orderIndex: number;
  sectionId?: string;
};

const draftVersionCondition = isNull(questionnaireSections.versionId);
const questionDraftVersionCondition = isNull(questionnaireQuestions.versionId);
const logicDraftVersionCondition = isNull(questionnaireLogicRules.versionId);

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const generateAccessToken = () => randomBytes(32).toString("base64url");

const versionCondition = (column: any, versionId?: string | null) =>
  versionId ? eq(column, versionId) : isNull(column);

const isEmptyAnswer = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
};

const remapJsonIds = (value: unknown, idMap: Map<string, string>): unknown => {
  if (typeof value === "string") return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapJsonIds(item, idMap));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, currentValue]) => [
        idMap.get(key) ?? key,
        remapJsonIds(currentValue, idMap),
      ]),
    );
  }
  return value;
};

const compareValues = (
  left: unknown,
  operator: string,
  right: unknown,
): boolean => {
  switch (operator) {
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "contains":
      return typeof left === "string" && typeof right === "string"
        ? left.includes(right)
        : Array.isArray(left) && left.includes(right);
    case "not_contains":
      return !compareValues(left, "contains", right);
    case "greater_than":
      return Number(left) > Number(right);
    case "less_than":
      return Number(left) < Number(right);
    case "between":
      return (
        Array.isArray(right) &&
        right.length === 2 &&
        Number(left) >= Number(right[0]) &&
        Number(left) <= Number(right[1])
      );
    case "empty":
      return isEmptyAnswer(left);
    case "not_empty":
      return !isEmptyAnswer(left);
    case "includes_any":
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        right.some((value) => left.includes(value))
      );
    case "includes_all":
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        right.every((value) => left.includes(value))
      );
    default:
      return false;
  }
};

const evaluateCondition = (
  condition: unknown,
  answersByQuestionId: Map<string, unknown>,
): boolean => {
  if (!condition || typeof condition !== "object") return false;
  const current = condition as JsonObject;

  if (Array.isArray(current.all)) {
    return current.all.every((item) =>
      evaluateCondition(item, answersByQuestionId),
    );
  }

  if (Array.isArray(current.any)) {
    return current.any.some((item) =>
      evaluateCondition(item, answersByQuestionId),
    );
  }

  if (Array.isArray(current.none)) {
    return current.none.every(
      (item) => !evaluateCondition(item, answersByQuestionId),
    );
  }

  const questionId = current.questionId;
  const operator = current.operator;
  if (typeof questionId !== "string" || typeof operator !== "string") {
    return false;
  }

  return compareValues(
    answersByQuestionId.get(questionId),
    operator,
    current.value,
  );
};

const buildResponseFileStoragePath = (
  organizationId: string,
  responseId: string,
  questionId: string,
  filename: string,
) => `questionnaire-responses/${organizationId}/${responseId}/${questionId}/${filename}`;

export class QuestionnairesService {
  getAllQuestionnaires = async (
    organizationId: string,
    filters: Partial<PaginationParams> & {
      search?: string;
      status?: string;
      caseTypeId?: string;
    } = {},
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });
    const conditions = [eq(questionnaires.organizationId, organizationId)];

    if (filters.status) {
      conditions.push(eq(questionnaires.status, filters.status as any));
    }

    if (filters.search) {
      const search = `%${filters.search}%`;
      const searchCondition = or(
        ilike(questionnaires.title, search),
        ilike(questionnaires.description, search),
      );
      if (searchCondition) conditions.push(searchCondition);
    }

    if (filters.caseTypeId) {
      const matchingLinks = await db
        .select({ questionnaireId: questionnaireCaseTypes.questionnaireId })
        .from(questionnaireCaseTypes)
        .where(eq(questionnaireCaseTypes.caseTypeId, filters.caseTypeId));

      if (!matchingLinks.length) {
        return buildPaginatedResponse([], {
          page,
          limit,
          total: 0,
        });
      }

      conditions.push(
        inArray(
          questionnaires.id,
          matchingLinks.map((link) => link.questionnaireId),
        ),
      );
    }

    const where = and(...conditions);
    const [{ total }] = await db
      .select({ total: count() })
      .from(questionnaires)
      .where(where);

    const rows = await db
      .select()
      .from(questionnaires)
      .where(where)
      .orderBy(desc(questionnaires.createdAt))
      .limit(limit)
      .offset(offset);

    return buildPaginatedResponse(rows, {
      page,
      limit,
      total: Number(total),
    });
  };

  createQuestionnaire = async (
    organizationId: string,
    data: {
      title: string;
      description?: string | null;
      createdById?: string | null;
      firstSectionTitle?: string;
      caseTypeIds?: string[];
    },
  ) => {
    return db.transaction(async (tx) => {
      if (data.caseTypeIds?.length) {
        await this.ensureCaseTypes(data.caseTypeIds, tx);
      }

      const [created] = await tx
        .insert(questionnaires)
        .values({
          organizationId,
          title: data.title,
          description: data.description,
          createdById: data.createdById,
        })
        .returning();

      await tx.insert(questionnaireSections).values({
        questionnaireId: created.id,
        title: data.firstSectionTitle || "Section 1",
        description: null,
        orderIndex: 0,
      });

      if (data.caseTypeIds?.length) {
        await this.insertQuestionnaireCaseTypes(
          created.id,
          data.caseTypeIds,
          tx,
        );
      }

      return this.getQuestionnaireById(created.id, organizationId, tx);
    });
  };

  getQuestionnaireById = async (
    id: string,
    organizationId: string,
    database: any = db,
  ) => {
    const [questionnaire] = await database
      .select()
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.id, id),
          eq(questionnaires.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!questionnaire) return null;

    const versionId = questionnaire.publishedVersionId ?? null;
    const [publishedVersion] = versionId
      ? await database
          .select()
          .from(questionnaireVersions)
          .where(eq(questionnaireVersions.id, versionId))
          .limit(1)
      : [null];

    const structure = await this.getQuestionnaireStructure(
      questionnaire.id,
      organizationId,
      null,
      database,
    );

    const publishedCaseTypes = versionId
      ? await this.getQuestionnaireCaseTypes(questionnaire.id, versionId, database)
      : [];

    return {
      ...questionnaire,
      publishedVersion,
      publishedCaseTypes,
      ...structure,
    };
  };

  updateQuestionnaire = async (
    id: string,
    organizationId: string,
    data: {
      title?: string;
      description?: string | null;
      status?: "draft" | "published" | "archived";
      caseTypeIds?: string[];
    },
  ) => {
    const existing = await this.ensureQuestionnaire(id, organizationId);

    if (data.status === "published") {
      throw new BadRequestError("Use the publish endpoint to publish questionnaires");
    }

    if (existing.status !== "draft") {
      const onlyArchiving =
        Object.keys(data).length === 1 && data.status === "archived";
      if (!onlyArchiving) {
        throw new ConflictError("Only draft questionnaires can be edited");
      }
    }

    return db.transaction(async (tx) => {
      const { caseTypeIds, ...questionnaireData } = data;

      const [updated] = await tx
        .update(questionnaires)
        .set({
          ...questionnaireData,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(questionnaires.id, id),
            eq(questionnaires.organizationId, organizationId),
          ),
        )
        .returning();

      if (caseTypeIds) {
        if (existing.status !== "draft") {
          throw new ConflictError(
            "Case types can only be changed on draft questionnaires",
          );
        }

        await this.replaceQuestionnaireCaseTypes(id, caseTypeIds, tx);
      }

      return updated;
    });
  };

  publishQuestionnaire = async (id: string, organizationId: string) => {
    return db.transaction(async (tx) => {
      const questionnaire = await this.ensureQuestionnaire(id, organizationId, tx);
      if (questionnaire.status === "archived") {
        throw new ConflictError("Archived questionnaires cannot be published");
      }

      const draftSections = await tx
        .select()
        .from(questionnaireSections)
        .where(
          and(
            eq(questionnaireSections.questionnaireId, id),
            draftVersionCondition,
          ),
        );

      if (!draftSections.length) {
        throw new BadRequestError(
          "Questionnaire must have at least one section before publishing",
        );
      }

      const draftCaseTypes = await this.getQuestionnaireCaseTypes(id, null, tx);
      if (!draftCaseTypes.length) {
        throw new BadRequestError(
          "Questionnaire must have at least one case type before publishing",
        );
      }

      const [{ total: questionCount }] = await tx
        .select({ total: count() })
        .from(questionnaireQuestions)
        .where(
          and(
            eq(questionnaireQuestions.questionnaireId, id),
            questionDraftVersionCondition,
          ),
        );

      if (!Number(questionCount)) {
        throw new BadRequestError(
          "Questionnaire must have at least one question before publishing",
        );
      }

      const [{ currentVersion }] = await tx
        .select({ currentVersion: max(questionnaireVersions.versionNumber) })
        .from(questionnaireVersions)
        .where(eq(questionnaireVersions.questionnaireId, id));

      const [version] = await tx
        .insert(questionnaireVersions)
        .values({
          questionnaireId: id,
          organizationId,
          versionNumber: Number(currentVersion ?? 0) + 1,
          title: questionnaire.title,
          description: questionnaire.description,
        })
        .returning();

      const snapshot = await this.copyQuestionnaireStructure({
        tx,
        organizationId,
        sourceQuestionnaireId: id,
        targetQuestionnaireId: id,
        sourceVersionId: null,
        targetVersionId: version.id,
      });

      await tx.insert(questionnaireVersionCaseTypes).values(
        draftCaseTypes.map((caseType: { id: string }) => ({
          questionnaireId: id,
          questionnaireVersionId: version.id,
          caseTypeId: caseType.id,
        })),
      );

      const versionCaseTypes = await this.getQuestionnaireCaseTypes(
        id,
        version.id,
        tx,
      );
      const versionSnapshot = {
        ...snapshot,
        caseTypes: versionCaseTypes,
      };

      await tx
        .update(questionnaireVersions)
        .set({ schemaSnapshot: versionSnapshot as any })
        .where(eq(questionnaireVersions.id, version.id));

      const [updated] = await tx
        .update(questionnaires)
        .set({
          status: "published",
          publishedVersionId: version.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(questionnaires.id, id),
            eq(questionnaires.organizationId, organizationId),
          ),
        )
        .returning();

      return {
        questionnaire: updated,
        version: {
          ...version,
          schemaSnapshot: versionSnapshot,
        },
      };
    });
  };

  duplicateQuestionnaire = async (
    id: string,
    organizationId: string,
    data: {
      title?: string;
      createdById?: string | null;
    } = {},
  ) => {
    return db.transaction(async (tx) => {
      const source = await this.ensureQuestionnaire(id, organizationId, tx);
      const sourceVersionId =
        source.status === "draft" ? null : source.publishedVersionId;

      const [created] = await tx
        .insert(questionnaires)
        .values({
          organizationId,
          title: data.title || `${source.title} Copy`,
          description: source.description,
          status: "draft",
          createdById: data.createdById,
          sourceQuestionnaireId: source.id,
        })
        .returning();

      await this.copyQuestionnaireStructure({
        tx,
        organizationId,
        sourceQuestionnaireId: source.id,
        targetQuestionnaireId: created.id,
        sourceVersionId,
        targetVersionId: null,
      });

      await this.copyQuestionnaireCaseTypes({
        tx,
        sourceQuestionnaireId: source.id,
        targetQuestionnaireId: created.id,
        sourceVersionId,
      });

      return this.getQuestionnaireById(created.id, organizationId, tx);
    });
  };

  addSection = async (
    questionnaireId: string,
    organizationId: string,
    data: {
      title: string;
      description?: string | null;
      orderIndex?: number;
    },
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);
    const orderIndex =
      data.orderIndex ??
      (await this.getNextSectionOrderIndex(questionnaireId, null));

    const [created] = await db
      .insert(questionnaireSections)
      .values({
        questionnaireId,
        title: data.title,
        description: data.description,
        orderIndex,
      })
      .returning();

    return created;
  };

  reorderSections = async (
    questionnaireId: string,
    organizationId: string,
    items: ReorderItem[],
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);
    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .update(questionnaireSections)
          .set({ orderIndex: item.orderIndex, updatedAt: new Date() })
          .where(
            and(
              eq(questionnaireSections.id, item.id),
              eq(questionnaireSections.questionnaireId, questionnaireId),
              draftVersionCondition,
            ),
          );
      }
    });

    return this.getQuestionnaireStructure(questionnaireId, organizationId);
  };

  addQuestion = async (
    questionnaireId: string,
    organizationId: string,
    data: QuestionInput,
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);
    await this.ensureDraftSection(data.sectionId, questionnaireId);

    const orderIndex =
      data.orderIndex ??
      (await this.getNextQuestionOrderIndex(questionnaireId, data.sectionId, null));

    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(questionnaireQuestions)
        .values({
          questionnaireId,
          sectionId: data.sectionId,
          label: data.label,
          description: data.description,
          type: data.type,
          orderIndex,
          isRequired: data.isRequired ?? false,
          config: (data.config ?? {}) as any,
        })
        .returning();

      if (data.options?.length) {
        await tx.insert(questionnaireQuestionOptions).values(
          data.options.map((option, index) => ({
            questionId: created.id,
            label: option.label,
            value: option.value,
            orderIndex: option.orderIndex ?? index,
          })),
        );
      }

      return this.getQuestionById(created.id, tx);
    });
  };

  updateQuestion = async (
    questionnaireId: string,
    questionId: string,
    organizationId: string,
    data: Partial<QuestionInput>,
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);
    const existing = await this.ensureDraftQuestion(questionId, questionnaireId);

    if (data.sectionId && data.sectionId !== existing.sectionId) {
      await this.ensureDraftSection(data.sectionId, questionnaireId);
    }

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(questionnaireQuestions)
        .set({
          sectionId: data.sectionId,
          label: data.label,
          description: data.description,
          type: data.type,
          orderIndex: data.orderIndex,
          isRequired: data.isRequired,
          config: data.config as any,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(questionnaireQuestions.id, questionId),
            eq(questionnaireQuestions.questionnaireId, questionnaireId),
            questionDraftVersionCondition,
          ),
        )
        .returning();

      if (data.options) {
        await tx
          .delete(questionnaireQuestionOptions)
          .where(eq(questionnaireQuestionOptions.questionId, questionId));

        if (data.options.length) {
          await tx.insert(questionnaireQuestionOptions).values(
            data.options.map((option, index) => ({
              questionId,
              label: option.label,
              value: option.value,
              orderIndex: option.orderIndex ?? index,
            })),
          );
        }
      }

      return this.getQuestionById(updated.id, tx);
    });
  };

  reorderQuestions = async (
    questionnaireId: string,
    organizationId: string,
    items: ReorderItem[],
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);

    await db.transaction(async (tx) => {
      for (const item of items) {
        if (item.sectionId) {
          await this.ensureDraftSection(item.sectionId, questionnaireId, tx);
        }

        await tx
          .update(questionnaireQuestions)
          .set({
            sectionId: item.sectionId,
            orderIndex: item.orderIndex,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(questionnaireQuestions.id, item.id),
              eq(questionnaireQuestions.questionnaireId, questionnaireId),
              questionDraftVersionCondition,
            ),
          );
      }
    });

    return this.getQuestionnaireStructure(questionnaireId, organizationId);
  };

  addLogicRule = async (
    questionnaireId: string,
    organizationId: string,
    data: {
      sourceQuestionId?: string | null;
      condition: JsonObject;
      actionType:
        | "show_question"
        | "hide_question"
        | "skip_to_question"
        | "skip_to_section"
        | "require_question"
        | "branch_to_section"
        | "end_questionnaire";
      action: JsonObject;
      priority?: number;
    },
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);
    if (data.sourceQuestionId) {
      await this.ensureDraftQuestion(data.sourceQuestionId, questionnaireId);
    }

    const [created] = await db
      .insert(questionnaireLogicRules)
      .values({
        questionnaireId,
        sourceQuestionId: data.sourceQuestionId,
        condition: data.condition as any,
        actionType: data.actionType,
        action: data.action as any,
        priority: data.priority ?? 0,
      })
      .returning();

    return created;
  };

  sendToClient = async (
    questionnaireId: string,
    organizationId: string,
    data: {
      clientId: string;
      caseTypeId: string;
      caseId?: string | null;
      sentById?: string | null;
      expiresAt?: Date | null;
    },
  ) => {
    const questionnaire = await this.ensureQuestionnaire(
      questionnaireId,
      organizationId,
    );

    if (questionnaire.status !== "published" || !questionnaire.publishedVersionId) {
      throw new BadRequestError("Only published questionnaires can be sent");
    }

    await this.ensureVersionCaseType(
      questionnaire.id,
      questionnaire.publishedVersionId,
      data.caseTypeId,
    );

    if (data.caseId) {
      await this.ensureCaseMatchesSendContext({
        caseId: data.caseId,
        organizationId,
        clientId: data.clientId,
        caseTypeId: data.caseTypeId,
      });
    }

    const accessToken = generateAccessToken();
    const [send] = await db
      .insert(questionnaireSends)
      .values({
        organizationId,
        questionnaireId,
        questionnaireVersionId: questionnaire.publishedVersionId,
        clientId: data.clientId,
        caseTypeId: data.caseTypeId,
        caseId: data.caseId,
        sentById: data.sentById,
        accessTokenHash: tokenHash(accessToken),
        expiresAt: data.expiresAt,
      })
      .returning();

    return {
      ...send,
      accessToken,
    };
  };

  getResponses = async (
    questionnaireId: string,
    organizationId: string,
    filters: Partial<PaginationParams> & { caseTypeId?: string } = {},
  ) => {
    await this.ensureQuestionnaire(questionnaireId, organizationId);
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });
    const conditions = [
      eq(questionnaireResponses.questionnaireId, questionnaireId),
      eq(questionnaireResponses.organizationId, organizationId),
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

    return buildPaginatedResponse(rows, {
      page,
      limit,
      total: Number(total),
    });
  };

  setQuestionnaireCaseTypes = async (
    questionnaireId: string,
    organizationId: string,
    caseTypeIds: string[],
  ) => {
    await this.ensureEditableQuestionnaire(questionnaireId, organizationId);

    await db.transaction(async (tx) => {
      await this.replaceQuestionnaireCaseTypes(
        questionnaireId,
        caseTypeIds,
        tx,
      );
    });

    return this.getQuestionnaireById(questionnaireId, organizationId);
  };

  getQuestionnairesByCaseType = async (
    organizationId: string,
    caseTypeId: string,
    filters: Partial<PaginationParams> & {
      search?: string;
      status?: string;
    } = {},
  ) => {
    return this.getAllQuestionnaires(organizationId, {
      ...filters,
      caseTypeId,
    });
  };

  getEligibleQuestionnairesForCase = async (
    organizationId: string,
    caseId: string,
    filters: Partial<PaginationParams> = {},
  ) => {
    const caseRow = await this.ensureCaseForOrganization(caseId, organizationId);
    const caseType = await this.findCaseTypeForCase(
      caseRow.caseType,
      caseRow.practiceAreaId,
    );

    if (!caseType) {
      throw new NotFoundError("Matching case type not found");
    }

    return this.getAllQuestionnaires(organizationId, {
      ...filters,
      status: "published",
      caseTypeId: caseType.id,
    });
  };

  getClientQuestionnaireByToken = async (accessToken: string) => {
    const send = await this.getActiveSendByToken(accessToken, true);
    const questionnaire = await this.getQuestionnaireStructure(
      send.questionnaireId,
      send.organizationId,
      send.questionnaireVersionId,
    );
    const response = await this.getResponseForSend(send.id);

    return {
      send,
      questionnaire,
      response,
    };
  };

  saveDraftResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionId?: string | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    return this.saveResponse(send, {
      status: "draft",
      currentSectionId: data.currentSectionId,
      answers: data.answers ?? [],
    });
  };

  submitResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionId?: string | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    return this.saveResponse(send, {
      status: "submitted",
      currentSectionId: data.currentSectionId,
      answers: data.answers ?? [],
    });
  };

  uploadResponseFileByToken = async (
    accessToken: string,
    data: {
      responseId: string;
      questionId: string;
      fileBuffer: Buffer;
      mimeType: string;
      fileSize: number;
      originalFilename: string;
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    const response = await this.ensureResponseForSend(
      data.responseId,
      send.id,
      send.organizationId,
    );

    if (response.status === "submitted") {
      throw new ConflictError("Submitted responses cannot be changed");
    }

    await this.ensureVersionQuestion(
      data.questionId,
      send.questionnaireId,
      send.questionnaireVersionId,
    );

    const safeFilename = `${Date.now()}-${data.originalFilename.replace(/\s+/g, "_")}`;
    const storagePath = buildResponseFileStoragePath(
      send.organizationId,
      response.id,
      data.questionId,
      safeFilename,
    );

    const { error: uploadError } = await supabaseAdmin.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(storagePath, data.fileBuffer, {
        contentType: data.mimeType,
        upsert: false,
      });

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
        storagePath,
        fileUrl: urlData.publicUrl,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        originalFilename: data.originalFilename,
      })
      .returning();

    return file;
  };

  private ensureQuestionnaire = async (
    id: string,
    organizationId: string,
    database: any = db,
  ) => {
    const [questionnaire] = await database
      .select()
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.id, id),
          eq(questionnaires.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!questionnaire) throw new NotFoundError("Questionnaire not found");
    return questionnaire;
  };

  private ensureEditableQuestionnaire = async (
    id: string,
    organizationId: string,
  ) => {
    const questionnaire = await this.ensureQuestionnaire(id, organizationId);
    if (questionnaire.status !== "draft") {
      throw new ConflictError("Only draft questionnaires can be edited");
    }
    return questionnaire;
  };

  private ensureCaseTypes = async (caseTypeIds: string[], database: any = db) => {
    const uniqueCaseTypeIds = Array.from(new Set(caseTypeIds));
    if (!uniqueCaseTypeIds.length) return [];

    const rows = await database
      .select()
      .from(practiceAreaCaseTypes)
      .where(inArray(practiceAreaCaseTypes.id, uniqueCaseTypeIds));

    if (rows.length !== uniqueCaseTypeIds.length) {
      throw new BadRequestError("One or more case types are invalid");
    }

    return rows;
  };

  private insertQuestionnaireCaseTypes = async (
    questionnaireId: string,
    caseTypeIds: string[],
    database: any = db,
  ) => {
    const uniqueCaseTypeIds = Array.from(new Set(caseTypeIds));
    if (!uniqueCaseTypeIds.length) return;

    await database.insert(questionnaireCaseTypes).values(
      uniqueCaseTypeIds.map((caseTypeId) => ({
        questionnaireId,
        caseTypeId,
      })),
    );
  };

  private replaceQuestionnaireCaseTypes = async (
    questionnaireId: string,
    caseTypeIds: string[],
    database: any = db,
  ) => {
    const uniqueCaseTypeIds = Array.from(new Set(caseTypeIds));
    await this.ensureCaseTypes(uniqueCaseTypeIds, database);

    await database
      .delete(questionnaireCaseTypes)
      .where(eq(questionnaireCaseTypes.questionnaireId, questionnaireId));

    await this.insertQuestionnaireCaseTypes(
      questionnaireId,
      uniqueCaseTypeIds,
      database,
    );
  };

  private getQuestionnaireCaseTypes = async (
    questionnaireId: string,
    versionId?: string | null,
    database: any = db,
  ) => {
    const rows = versionId
      ? await database
          .select({
            id: practiceAreaCaseTypes.id,
            practiceAreaId: practiceAreaCaseTypes.practiceAreaId,
            code: practiceAreaCaseTypes.code,
            name: practiceAreaCaseTypes.name,
            caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
            createdAt: practiceAreaCaseTypes.createdAt,
            updatedAt: practiceAreaCaseTypes.updatedAt,
          })
          .from(questionnaireVersionCaseTypes)
          .innerJoin(
            practiceAreaCaseTypes,
            eq(
              practiceAreaCaseTypes.id,
              questionnaireVersionCaseTypes.caseTypeId,
            ),
          )
          .where(
            and(
              eq(questionnaireVersionCaseTypes.questionnaireId, questionnaireId),
              eq(questionnaireVersionCaseTypes.questionnaireVersionId, versionId),
            ),
          )
      : await database
          .select({
            id: practiceAreaCaseTypes.id,
            practiceAreaId: practiceAreaCaseTypes.practiceAreaId,
            code: practiceAreaCaseTypes.code,
            name: practiceAreaCaseTypes.name,
            caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
            createdAt: practiceAreaCaseTypes.createdAt,
            updatedAt: practiceAreaCaseTypes.updatedAt,
          })
          .from(questionnaireCaseTypes)
          .innerJoin(
            practiceAreaCaseTypes,
            eq(practiceAreaCaseTypes.id, questionnaireCaseTypes.caseTypeId),
          )
          .where(eq(questionnaireCaseTypes.questionnaireId, questionnaireId));

    return rows;
  };

  private copyQuestionnaireCaseTypes = async ({
    tx,
    sourceQuestionnaireId,
    targetQuestionnaireId,
    sourceVersionId,
  }: {
    tx: any;
    sourceQuestionnaireId: string;
    targetQuestionnaireId: string;
    sourceVersionId?: string | null;
  }) => {
    const sourceCaseTypes = await this.getQuestionnaireCaseTypes(
      sourceQuestionnaireId,
      sourceVersionId,
      tx,
    );

    await this.insertQuestionnaireCaseTypes(
      targetQuestionnaireId,
      sourceCaseTypes.map((caseType: { id: string }) => caseType.id),
      tx,
    );
  };

  private ensureVersionCaseType = async (
    questionnaireId: string,
    questionnaireVersionId: string,
    caseTypeId: string,
    database: any = db,
  ) => {
    const [link] = await database
      .select()
      .from(questionnaireVersionCaseTypes)
      .where(
        and(
          eq(questionnaireVersionCaseTypes.questionnaireId, questionnaireId),
          eq(
            questionnaireVersionCaseTypes.questionnaireVersionId,
            questionnaireVersionId,
          ),
          eq(questionnaireVersionCaseTypes.caseTypeId, caseTypeId),
        ),
      )
      .limit(1);

    if (!link) {
      throw new BadRequestError(
        "Questionnaire version is not linked to this case type",
      );
    }

    return link;
  };

  private ensureCaseForOrganization = async (
    caseId: string,
    organizationId: string,
    database: any = db,
  ) => {
    const [caseRow] = await database
      .select()
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!caseRow) throw new NotFoundError("Case not found");
    return caseRow;
  };

  private findCaseTypeForCase = async (
    caseType: string,
    practiceAreaId?: string,
    database: any = db,
  ) => {
    const caseTypeCondition = or(
      eq(practiceAreaCaseTypes.code, caseType),
      eq(practiceAreaCaseTypes.name, caseType),
    );

    const [caseTypeRow] = await database
      .select()
      .from(practiceAreaCaseTypes)
      .where(
        practiceAreaId
          ? and(
              eq(practiceAreaCaseTypes.practiceAreaId, practiceAreaId),
              caseTypeCondition,
            )
          : caseTypeCondition,
      )
      .limit(1);

    return caseTypeRow ?? null;
  };

  private ensureCaseMatchesSendContext = async ({
    caseId,
    organizationId,
    clientId,
    caseTypeId,
  }: {
    caseId: string;
    organizationId: string;
    clientId: string;
    caseTypeId: string;
  }) => {
    const caseRow = await this.ensureCaseForOrganization(caseId, organizationId);
    if (caseRow.clientId !== clientId) {
      throw new BadRequestError("Case does not belong to this client");
    }

    const caseType = await this.findCaseTypeForCase(
      caseRow.caseType,
      caseRow.practiceAreaId,
    );
    if (!caseType) {
      throw new BadRequestError("Case type could not be resolved");
    }

    if (caseType.id !== caseTypeId) {
      throw new BadRequestError("Case type does not match the selected case");
    }

    return caseRow;
  };

  private ensureDraftSection = async (
    sectionId: string,
    questionnaireId: string,
    database: any = db,
  ) => {
    const [section] = await database
      .select()
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.id, sectionId),
          eq(questionnaireSections.questionnaireId, questionnaireId),
          draftVersionCondition,
        ),
      )
      .limit(1);

    if (!section) throw new NotFoundError("Section not found");
    return section;
  };

  private ensureDraftQuestion = async (
    questionId: string,
    questionnaireId: string,
    database: any = db,
  ) => {
    const [question] = await database
      .select()
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.id, questionId),
          eq(questionnaireQuestions.questionnaireId, questionnaireId),
          questionDraftVersionCondition,
        ),
      )
      .limit(1);

    if (!question) throw new NotFoundError("Question not found");
    return question;
  };

  private ensureVersionQuestion = async (
    questionId: string,
    questionnaireId: string,
    versionId: string,
    database: any = db,
  ) => {
    const [question] = await database
      .select()
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.id, questionId),
          eq(questionnaireQuestions.questionnaireId, questionnaireId),
          eq(questionnaireQuestions.versionId, versionId),
        ),
      )
      .limit(1);

    if (!question) throw new NotFoundError("Question not found");
    return question;
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

  private getQuestionById = async (questionId: string, database: any = db) => {
    const [question] = await database
      .select()
      .from(questionnaireQuestions)
      .where(eq(questionnaireQuestions.id, questionId))
      .limit(1);

    const options = await database
      .select()
      .from(questionnaireQuestionOptions)
      .where(eq(questionnaireQuestionOptions.questionId, questionId))
      .orderBy(asc(questionnaireQuestionOptions.orderIndex));

    return { ...question, options };
  };

  private getNextSectionOrderIndex = async (
    questionnaireId: string,
    versionId: string | null,
    database: any = db,
  ) => {
    const [{ currentOrderIndex }] = await database
      .select({ currentOrderIndex: max(questionnaireSections.orderIndex) })
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.questionnaireId, questionnaireId),
          versionCondition(questionnaireSections.versionId, versionId),
        ),
      );

    return Number(currentOrderIndex ?? -1) + 1;
  };

  private getNextQuestionOrderIndex = async (
    questionnaireId: string,
    sectionId: string,
    versionId: string | null,
    database: any = db,
  ) => {
    const [{ currentOrderIndex }] = await database
      .select({ currentOrderIndex: max(questionnaireQuestions.orderIndex) })
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.questionnaireId, questionnaireId),
          eq(questionnaireQuestions.sectionId, sectionId),
          versionCondition(questionnaireQuestions.versionId, versionId),
        ),
      );

    return Number(currentOrderIndex ?? -1) + 1;
  };

  private getQuestionnaireStructure = async (
    questionnaireId: string,
    organizationId: string,
    versionId?: string | null,
    database: any = db,
  ) => {
    await this.ensureQuestionnaire(questionnaireId, organizationId, database);

    const sections = await database
      .select()
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.questionnaireId, questionnaireId),
          versionCondition(questionnaireSections.versionId, versionId),
        ),
      )
      .orderBy(asc(questionnaireSections.orderIndex));

    const questions = await database
      .select()
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.questionnaireId, questionnaireId),
          versionCondition(questionnaireQuestions.versionId, versionId),
        ),
      )
      .orderBy(asc(questionnaireQuestions.orderIndex));

    const questionIds = questions.map((question: any) => question.id);
    const options = questionIds.length
      ? await database
          .select()
          .from(questionnaireQuestionOptions)
          .where(inArray(questionnaireQuestionOptions.questionId, questionIds))
          .orderBy(asc(questionnaireQuestionOptions.orderIndex))
      : [];

    const logicRules = await database
      .select()
      .from(questionnaireLogicRules)
      .where(
        and(
          eq(questionnaireLogicRules.questionnaireId, questionnaireId),
          versionCondition(questionnaireLogicRules.versionId, versionId),
        ),
      )
      .orderBy(asc(questionnaireLogicRules.priority));

    const caseTypes = await this.getQuestionnaireCaseTypes(
      questionnaireId,
      versionId,
      database,
    );

    const optionsByQuestion = new Map<string, typeof options>();
    for (const option of options) {
      const current = optionsByQuestion.get(option.questionId) ?? [];
      current.push(option);
      optionsByQuestion.set(option.questionId, current);
    }

    const questionsBySection = new Map<string, typeof questions>();
    for (const question of questions) {
      const current = questionsBySection.get(question.sectionId) ?? [];
      current.push({
        ...question,
        options: optionsByQuestion.get(question.id) ?? [],
      });
      questionsBySection.set(question.sectionId, current);
    }

    return {
      caseTypes,
      sections: sections.map((section: any) => ({
        ...section,
        questions: questionsBySection.get(section.id) ?? [],
      })),
      logicRules,
    };
  };

  private copyQuestionnaireStructure = async ({
    tx,
    organizationId,
    sourceQuestionnaireId,
    targetQuestionnaireId,
    sourceVersionId,
    targetVersionId,
  }: {
    tx: any;
    organizationId: string;
    sourceQuestionnaireId: string;
    targetQuestionnaireId: string;
    sourceVersionId?: string | null;
    targetVersionId?: string | null;
  }) => {
    const sectionIdMap = new Map<string, string>();
    const questionIdMap = new Map<string, string>();

    const sourceSections = await tx
      .select()
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.questionnaireId, sourceQuestionnaireId),
          versionCondition(questionnaireSections.versionId, sourceVersionId),
        ),
      )
      .orderBy(asc(questionnaireSections.orderIndex));

    for (const section of sourceSections) {
      const [created] = await tx
        .insert(questionnaireSections)
        .values({
          questionnaireId: targetQuestionnaireId,
          versionId: targetVersionId,
          title: section.title,
          description: section.description,
          orderIndex: section.orderIndex,
        })
        .returning();
      sectionIdMap.set(section.id, created.id);
    }

    const sourceQuestions = await tx
      .select()
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.questionnaireId, sourceQuestionnaireId),
          versionCondition(questionnaireQuestions.versionId, sourceVersionId),
        ),
      )
      .orderBy(asc(questionnaireQuestions.orderIndex));

    for (const question of sourceQuestions) {
      const sectionId = sectionIdMap.get(question.sectionId);
      if (!sectionId) continue;

      const [created] = await tx
        .insert(questionnaireQuestions)
        .values({
          questionnaireId: targetQuestionnaireId,
          sectionId,
          versionId: targetVersionId,
          label: question.label,
          description: question.description,
          type: question.type,
          orderIndex: question.orderIndex,
          isRequired: question.isRequired,
          config: question.config as any,
        })
        .returning();
      questionIdMap.set(question.id, created.id);
    }

    if (sourceQuestions.length) {
      const sourceQuestionIds = sourceQuestions.map((question: any) => question.id);
      const sourceOptions = await tx
        .select()
        .from(questionnaireQuestionOptions)
        .where(inArray(questionnaireQuestionOptions.questionId, sourceQuestionIds))
        .orderBy(asc(questionnaireQuestionOptions.orderIndex));

      for (const option of sourceOptions) {
        const questionId = questionIdMap.get(option.questionId);
        if (!questionId) continue;
        await tx.insert(questionnaireQuestionOptions).values({
          questionId,
          label: option.label,
          value: option.value,
          orderIndex: option.orderIndex,
        });
      }
    }

    const idMap = new Map<string, string>([
      ...sectionIdMap.entries(),
      ...questionIdMap.entries(),
    ]);

    const sourceLogicRules = await tx
      .select()
      .from(questionnaireLogicRules)
      .where(
        and(
          eq(questionnaireLogicRules.questionnaireId, sourceQuestionnaireId),
          versionCondition(questionnaireLogicRules.versionId, sourceVersionId),
        ),
      )
      .orderBy(asc(questionnaireLogicRules.priority));

    for (const rule of sourceLogicRules) {
      await tx.insert(questionnaireLogicRules).values({
        questionnaireId: targetQuestionnaireId,
        versionId: targetVersionId,
        sourceQuestionId: rule.sourceQuestionId
          ? questionIdMap.get(rule.sourceQuestionId)
          : null,
        condition: remapJsonIds(rule.condition, idMap) as any,
        actionType: rule.actionType,
        action: remapJsonIds(rule.action, idMap) as any,
        priority: rule.priority,
      });
    }

    return this.getQuestionnaireStructure(
      targetQuestionnaireId,
      organizationId,
      targetVersionId,
      tx,
    );
  };

  private getActiveSendByToken = async (
    accessToken: string,
    markOpened = false,
  ) => {
    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.accessTokenHash, tokenHash(accessToken)))
      .limit(1);

    if (!send) throw new NotFoundError("Questionnaire send not found");
    if (send.status === "revoked") {
      throw new ConflictError("Questionnaire send has been revoked");
    }
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
        .set({
          status: "opened",
          openedAt: new Date(),
          updatedAt: new Date(),
        })
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

    return {
      ...response,
      answers,
      files,
    };
  };

  private saveResponse = async (
    send: typeof questionnaireSends.$inferSelect,
    data: {
      status: "draft" | "submitted";
      currentSectionId?: string | null;
      answers: AnswerInput[];
    },
  ) => {
    return db.transaction(async (tx) => {
      const existing = await this.getResponseForSend(send.id, tx);
      if (existing?.status === "submitted") {
        throw new ConflictError("Client has already submitted a response");
      }

      const answerMap = new Map<string, unknown>();
      for (const answer of existing?.answers ?? []) {
        answerMap.set(answer.questionId, answer.value);
      }
      for (const answer of data.answers) {
        answerMap.set(answer.questionId, answer.value);
      }

      const mergedAnswers = Array.from(answerMap.entries()).map(
        ([questionId, value]) => ({ questionId, value }),
      );

      await this.validateResponseAnswers(
        send,
        mergedAnswers,
        data.status,
        tx,
      );

      const now = new Date();
      const [response] = existing
        ? await tx
            .update(questionnaireResponses)
            .set({
              status: data.status,
              currentSectionId: data.currentSectionId,
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
              questionnaireId: send.questionnaireId,
              questionnaireVersionId: send.questionnaireVersionId,
              clientId: send.clientId,
              caseId: send.caseId,
              caseTypeId: send.caseTypeId,
              status: data.status,
              currentSectionId: data.currentSectionId,
              lastSavedAt: now,
              submittedAt: data.status === "submitted" ? now : null,
            })
            .returning();

      for (const answer of data.answers) {
        await tx
          .insert(questionnaireAnswers)
          .values({
            responseId: response.id,
            questionId: answer.questionId,
            value: answer.value as any,
          })
          .onConflictDoUpdate({
            target: [
              questionnaireAnswers.responseId,
              questionnaireAnswers.questionId,
            ],
            set: {
              value: answer.value as any,
              updatedAt: now,
            },
          });
      }

      await tx
        .update(questionnaireSends)
        .set({
          status:
            data.status === "submitted" ? "submitted" : "draft_response",
          submittedAt: data.status === "submitted" ? now : null,
          updatedAt: now,
        })
        .where(eq(questionnaireSends.id, send.id));

      return this.getResponseForSend(send.id, tx);
    });
  };

  private validateResponseAnswers = async (
    send: typeof questionnaireSends.$inferSelect,
    answers: AnswerInput[],
    status: "draft" | "submitted",
    database: any,
  ) => {
    const questions = await database
      .select()
      .from(questionnaireQuestions)
      .where(
        and(
          eq(questionnaireQuestions.questionnaireId, send.questionnaireId),
          eq(questionnaireQuestions.versionId, send.questionnaireVersionId),
        ),
      );

    const questionById = new Map(
      questions.map((question: any) => [question.id, question]),
    );

    for (const answer of answers) {
      if (!questionById.has(answer.questionId)) {
        throw new BadRequestError("Answer contains an unknown question");
      }
    }

    if (status !== "submitted") return;

    const answerByQuestionId = new Map(
      answers.map((answer) => [answer.questionId, answer.value]),
    );

    const logicRules = await database
      .select()
      .from(questionnaireLogicRules)
      .where(
        and(
          eq(questionnaireLogicRules.questionnaireId, send.questionnaireId),
          eq(questionnaireLogicRules.versionId, send.questionnaireVersionId),
        ),
      );

    const requiredQuestionIds = new Set(
      questions
        .filter((question: any) => question.isRequired)
        .map((question: any) => question.id),
    );

    for (const rule of logicRules) {
      if (rule.actionType !== "require_question") continue;
      if (!evaluateCondition(rule.condition, answerByQuestionId)) continue;

      const action = rule.action as JsonObject;
      const targetQuestionId = action.targetQuestionId ?? action.questionId;
      if (typeof targetQuestionId === "string") {
        requiredQuestionIds.add(targetQuestionId);
      }
    }

    const missingRequired = questions
      .filter((question: any) => requiredQuestionIds.has(question.id))
      .filter((question: any) =>
        isEmptyAnswer(answerByQuestionId.get(question.id)),
      );

    if (missingRequired.length) {
      throw new BadRequestError("Required answers are missing", {
        questionIds: missingRequired.map((question: any) => question.id),
      });
    }
  };
}
