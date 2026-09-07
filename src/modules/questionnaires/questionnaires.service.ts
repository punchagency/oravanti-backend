import { createHash, randomBytes } from "crypto";
import { and, asc, count, desc, eq, ilike, isNull, or } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import PDFDocument from "pdfkit";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
import { cases } from "../../db/schema/cases";
import { conflictChecks } from "../../db/schema/conflict-checks";
import { scenarioDocumentRequirements } from "../../db/schema/document-requirements";
import { documents, documentVersions } from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import { leads } from "../../db/schema/leads";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import {
  questionnaireAnswerRevisions,
  questionnaireAnswers,
  questionnaireLogicRules,
  questionnaireQuestions,
  questionnaireResponseFiles,
  questionnaireResponses,
  questionnaires,
  questionnaireSections,
  questionnaireSends,
  type QuestionnaireScope,
  type QuestionnaireStage,
} from "../../db/schema/questionnaires";
import { hiddenQuestions, type LogicRule } from "../../lib/questionnaire/logic";
import { cancelQuestionnaireReminder } from "../../queue/queues";
import { sendQuestionnaireReminder } from "../../queue/workers/reminder.worker";
import { formatWithZone } from "../../utils/date";
import { notify } from "../../notifications/notification.service";
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
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { triggerScenarioScan } from "../ai-scan/scan-triggers";
import { flagsByDocument } from "../case-review/document-flags";

const log = createModuleLogger("questionnaires.service");
import {
  addDocumentVersion,
  computeChecksum,
  ingestDocument,
} from "../documents/document-ingest";
import { logLeadEvent } from "../leads/lead-events.service";
import { populateCaseForms } from "../workflow/form-population.service";
import {
  answersFromVersion,
  commitAnswers,
  getVersion,
  listAnswerRevisions,
  listVersions,
} from "./answer-history.service";
import { getFirmTimezone } from "../settings/consultation/consultation-settings.service";

type JsonObject = Record<string, unknown>;
type AnswerInput = { questionId: string; value: unknown };

/**
 * The scopes a tenant request may write. `system` is absent deliberately —
 * those rows belong to the platform and are created only by the seeds and the
 * platform-admin endpoints, never by a firm.
 */
type FirmScope = Exclude<QuestionnaireScope, "system">;

/** Platform questions first, then the firm's, then this matter's. */
const SCOPE_ORDER: Record<QuestionnaireScope, number> = {
  system: 0,
  firm: 1,
  case: 2,
};

const byScopeThenOrder = (
  a: { scope: QuestionnaireScope; orderIndex: number },
  b: { scope: QuestionnaireScope; orderIndex: number },
) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.orderIndex - b.orderIndex;

type QuestionInput = {
  label: string;
  description?: string | null;
  /** Stable name a form-field mapping can point at. See the schema. */
  fieldKey?: string | null;
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
    | "signature"
    | "repeat_group";
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

/** Raw token for the client link; only its hash is stored. */
const generateAccessToken = () => randomBytes(32).toString("base64url");


const isEmptyAnswer = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object")
    return Object.keys(value as object).length === 0;
  return false;
};

const buildResponseFileStoragePath = (
  organizationId: string,
  responseId: string,
  questionId: string,
  filename: string,
) =>
  `questionnaire-responses/${organizationId}/${responseId}/${questionId}/${filename}`;

/**
 * Response files are now a join row plus a document version. This projects the
 * pair back into the flat shape callers (and the API) already expect, so the
 * normalization stays invisible above this layer.
 */
const responseFileColumns = {
  id: questionnaireResponseFiles.id,
  organizationId: questionnaireResponseFiles.organizationId,
  responseId: questionnaireResponseFiles.responseId,
  questionId: questionnaireResponseFiles.questionId,
  documentId: questionnaireResponseFiles.documentId,
  createdAt: questionnaireResponseFiles.createdAt,
  storagePath: documentVersions.filePath,
  originalFilename: documentVersions.originalFileName,
  mimeType: documentVersions.mimeType,
  fileSize: documentVersions.fileSize,
  checksum: documentVersions.checksum,
  versionNumber: documentVersions.versionNumber,
  aiScanStatus: documentVersions.aiScanStatus,
};

/** Join a response file to its document's CURRENT version. */
const responseFilesQuery = () =>
  db
    .select(responseFileColumns)
    .from(questionnaireResponseFiles)
    .innerJoin(
      documents,
      eq(documents.id, questionnaireResponseFiles.documentId),
    )
    .innerJoin(
      documentVersions,
      eq(documentVersions.id, documents.currentVersionId),
    );

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

/** A questionnaire as the client was served it: sections, questions, rules. */
type ClientSchema = {
  sections?: Array<{
    id?: string;
    questions?: Array<{ id: string; isRequired?: boolean }>;
  }>;
  logicRules?: LogicRule[];
};

/**
 * Which of a schema's questions the answers so far put out of sight.
 *
 * The single place the server asks that. Required-validation, the completion
 * count and the save all need the same answer — a question the client was never
 * shown must not block their submission, must not count against their progress,
 * and must not carry a stale answer onto a form — and three separate readings
 * of the rules would disagree on the day one of them was changed.
 */
const hiddenInSchema = (
  snapshot: unknown,
  answers: { questionId: string; value: unknown }[],
): Set<string> => {
  if (!snapshot || typeof snapshot !== "object") return new Set();

  const schema = snapshot as ClientSchema;
  const rules = schema.logicRules ?? [];
  if (rules.length === 0) return new Set();

  const sectionOfQuestion = new Map<string, string>();
  for (const section of schema.sections ?? []) {
    for (const question of section.questions ?? []) {
      if (section.id) sectionOfQuestion.set(question.id, section.id);
    }
  }

  return hiddenQuestions(
    rules,
    new Map(answers.map((a) => [a.questionId, a.value])),
    sectionOfQuestion,
  );
};

const validateSubmissionAnswers = (
  snapshot: unknown,
  answers: AnswerInput[],
) => {
  if (!snapshot || typeof snapshot !== "object") return;
  const s = snapshot as ClientSchema;
  const allQuestions = (s.sections ?? []).flatMap((sec) => sec.questions ?? []);
  const answerMap = new Map(answers.map((a) => [a.questionId, a.value]));

  // A required question inside a branch the client collapsed is not missing —
  // it was never asked. Without this, answering "No" to "have you been married
  // before" makes the submit button fail with an error pointing at an
  // ex-spouse field that is not on the screen.
  const hidden = hiddenInSchema(snapshot, answers);

  const missing = allQuestions
    .filter((q) => q.isRequired && !hidden.has(q.id))
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
  const s = snapshot as ClientSchema;

  // Out of the denominator as well as the numerator. "14 of 30" against a
  // screen showing 22 questions is a client wondering what they have missed.
  const hidden = hiddenInSchema(snapshot, answers);
  const allQuestions = (s.sections ?? [])
    .flatMap((sec) => sec.questions ?? [])
    .filter((q) => !hidden.has(q.id));

  const answeredIds = new Set<string>();
  for (const a of answers) {
    if (!isEmptyAnswer(a.value)) answeredIds.add(a.questionId);
  }
  for (const f of files) answeredIds.add(f.questionId);
  const answered = allQuestions.filter((q) => answeredIds.has(q.id)).length;
  return { answered, total: allQuestions.length };
};

export class QuestionnairesService {
  // ── Questionnaire Read ─────────────────────────────────────────────────────

  /**
   * Every questionnaire Oravanti ships, a page at a time.
   *
   * Paginated and joined to the taxonomy for the same reason: this is the
   * CRM's list, and a bare row was neither. It returned every questionnaire in
   * the deployment and named its case type only by uuid, so the page had to
   * fetch all 687 case types to render one column.
   */
  getSystemQuestionnaires = async (params: {
    stage?: QuestionnaireStage;
    page?: number;
    limit?: number;
    search?: string;
  } = {}) => {
    const page = Math.max(1, Math.floor(params.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 25)));

    const where = and(
      params.stage ? eq(questionnaires.stage, params.stage) : undefined,
      // Wildcards in the caller's own term are escaped, so searching for "%"
      // finds a literal one rather than everything.
      params.search
        ? ilike(
            questionnaires.title,
            `%${params.search.trim().replace(/([%_\\])/g, "\\$1")}%`,
          )
        : undefined,
    );

    const [rows, [totals]] = await Promise.all([
      db
        .select({
          id: questionnaires.id,
          caseTypeId: questionnaires.caseTypeId,
          caseTypeName: practiceAreaCaseTypes.name,
          stage: questionnaires.stage,
          title: questionnaires.title,
          description: questionnaires.description,
          createdAt: questionnaires.createdAt,
        })
        .from(questionnaires)
        .innerJoin(
          practiceAreaCaseTypes,
          eq(practiceAreaCaseTypes.id, questionnaires.caseTypeId),
        )
        .where(where)
        .orderBy(asc(questionnaires.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(questionnaires).where(where),
    ]);

    const total = totals?.total ?? 0;
    return {
      data: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  };

  getSystemQuestionnaireByCaseType = async (
    caseTypeId: string,
    stage: QuestionnaireStage = "intake",
  ) => {
    const [questionnaire] = await db
      .select()
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.caseTypeId, caseTypeId),
          eq(questionnaires.stage, stage),
        ),
      )
      .limit(1);

    if (!questionnaire) return null;
    return this.buildQuestionnaire(questionnaire.id);
  };

  getSystemQuestionnaireById = async (id: string) => {
    return this.buildQuestionnaire(id);
  };

  // ── System Questionnaire Management (platform admin) ─────────────────────

  /**
   * Platform-admin only. The one writer of `scope: "system"` rows, which carry
   * a NULL `organizationId` that database policy forbids any tenant connection
   * from inserting. Firms extend a questionnaire through `addSection` /
   * `addQuestion` below instead.
   */
  createSystemQuestionnaire = async (data: {
    caseTypeId: string;
    stage?: QuestionnaireStage;
    title: string;
    description?: string | null;
    sections?: SectionInput[];
  }) => {
    const stage = data.stage ?? "intake";

    return withTransaction(db, async () => {
      await this.ensureCaseTypeExists(data.caseTypeId);

      const [existing] = await db
        .select()
        .from(questionnaires)
        .where(
          and(
            eq(questionnaires.caseTypeId, data.caseTypeId),
            eq(questionnaires.stage, stage),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ConflictError(
          `A ${stage} questionnaire already exists for this case type`,
        );
      }

      const [questionnaire] = await db
        .insert(questionnaires)
        .values({
          caseTypeId: data.caseTypeId,
          stage,
          title: data.title,
          description: data.description,
        })
        .returning();

      for (const [i, section] of (data.sections ?? []).entries()) {
        const [s] = await db
          .insert(questionnaireSections)
          .values({
            questionnaireId: questionnaire.id,
            scope: "system",
            title: section.title,
            description: section.description,
            orderIndex: i,
          })
          .returning();

        for (const [j, question] of (section.questions ?? []).entries()) {
          await db.insert(questionnaireQuestions).values({
            questionnaireId: questionnaire.id,
            sectionId: s.id,
            scope: "system",
            fieldKey: question.fieldKey ?? null,
            label: question.label,
            description: question.description,
            type: question.type,
            orderIndex: j,
            isRequired: question.isRequired ?? false,
            config: (question.config ?? {}) as JsonObject,
          });
        }
      }

      const built = await this.buildQuestionnaire(questionnaire.id);
      // Unreachable: it was inserted three statements ago, inside this
      // transaction. Asserted rather than returned nullable so every caller
      // gets a non-nullable type instead of each re-checking what the insert
      // already settled.
      if (!built) throw new NotFoundError("Questionnaire not found");
      return built;
    });
  };

  addSystemSection = async (
    questionnaireId: string,
    data: { title: string; description?: string | null; orderIndex?: number },
  ) => {
    const [created] = await db
      .insert(questionnaireSections)
      .values({
        questionnaireId,
        scope: "system",
        title: data.title,
        description: data.description,
        orderIndex:
          data.orderIndex ??
          (await this.nextSectionOrderIndex(questionnaireId, "system", null)),
      })
      .returning();

    return created;
  };

  addSystemQuestion = async (
    questionnaireId: string,
    sectionId: string,
    data: QuestionInput & { orderIndex?: number },
  ) => {
    const [created] = await db
      .insert(questionnaireQuestions)
      .values({
        questionnaireId,
        sectionId,
        scope: "system",
        fieldKey: data.fieldKey ?? null,
        label: data.label,
        description: data.description,
        type: data.type,
        orderIndex:
          data.orderIndex ?? (await this.nextQuestionOrderIndex(sectionId)),
        isRequired: data.isRequired ?? false,
        config: (data.config ?? {}) as JsonObject,
      })
      .returning();

    return created;
  };

  /**
   * Reword the questionnaire itself.
   *
   * `caseTypeId` and `stage` are absent on purpose. Together they are the
   * questionnaire's identity — one per case type per stage, enforced by the
   * conflict check in `createSystemQuestionnaire` — so changing either would
   * not move a questionnaire but collide with the one already there.
   */
  updateSystemQuestionnaire = async (
    id: string,
    data: { title?: string; description?: string | null },
  ) => {
    const [updated] = await db
      .update(questionnaires)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(questionnaires.id, id))
      .returning();

    if (!updated) throw new NotFoundError("Questionnaire not found");

    return updated;
  };

  /**
   * Edit one of Oravanti's own sections.
   *
   * The exact inverse of `updateSection`: that one matches rows carrying a
   * firm's `organizationId`, this one matches rows carrying none. Between them
   * every section is writable by exactly one tier, and neither can reach the
   * other's — which is the whole ownership rule, expressed as two `where`
   * clauses rather than as a scope column somebody has to remember to check.
   */
  updateSystemSection = async (
    sectionId: string,
    data: { title?: string; description?: string | null; orderIndex?: number },
  ) => {
    const [updated] = await db
      .update(questionnaireSections)
      .set({ ...data, updatedAt: new Date() })
      .where(this.platformSection(sectionId))
      .returning();

    if (!updated) {
      throw new NotFoundError("Section not found, or it belongs to a firm");
    }

    return updated;
  };

  /**
   * Remove one of Oravanti's own sections, with its questions.
   *
   * Worth stating plainly, because it is the most consequential call in this
   * file: every firm loses the section, and the answers under it go with it by
   * cascade. A section that has been asked for real is history somebody may
   * need — reword it rather than delete it.
   */
  deleteSystemSection = async (sectionId: string) => {
    const [deleted] = await db
      .delete(questionnaireSections)
      .where(this.platformSection(sectionId))
      .returning();

    if (!deleted) {
      throw new NotFoundError("Section not found, or it belongs to a firm");
    }

    return deleted;
  };

  /** Edit one of Oravanti's own questions. Mirrors `updateSystemSection`. */
  updateSystemQuestion = async (
    questionId: string,
    data: Partial<QuestionInput> & { orderIndex?: number },
  ) => {
    const [updated] = await db
      .update(questionnaireQuestions)
      .set({
        ...data,
        config: data.config as JsonObject | undefined,
        updatedAt: new Date(),
      })
      .where(this.platformQuestion(questionId))
      .returning();

    if (!updated) {
      throw new NotFoundError("Question not found, or it belongs to a firm");
    }

    return updated;
  };

  /** Remove one of Oravanti's own questions, and every answer to it. */
  deleteSystemQuestion = async (questionId: string) => {
    const [deleted] = await db
      .delete(questionnaireQuestions)
      .where(this.platformQuestion(questionId))
      .returning();

    if (!deleted) {
      throw new NotFoundError("Question not found, or it belongs to a firm");
    }

    return deleted;
  };

  // ── Firm and per-matter additions ───────────────────────────────────────────

  /**
   * A questionnaire as one respondent will actually see it: the platform's
   * system backbone, this firm's standing additions, and — when a `caseId` is
   * given — the sections and questions a staff member wrote for that matter
   * alone.
   *
   * All three tiers are rows in the same two tables, so assembling them is a
   * single query per table and an ordering rule, where it used to be four
   * queries and a merge that cast to `any` to reconcile two row shapes.
   */
  getMergedQuestionnaire = async (
    organizationId: string,
    caseTypeId: string,
    opts: { stage?: QuestionnaireStage; caseId?: string | null } = {},
  ) => {
    const stage = opts.stage ?? "intake";
    const caseId = opts.caseId ?? null;

    const [questionnaire] = await db
      .select()
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.caseTypeId, caseTypeId),
          eq(questionnaires.stage, stage),
        ),
      )
      .limit(1);

    if (!questionnaire) {
      return { systemQuestionnaire: null, sections: [] };
    }

    const structure = await this.buildQuestionnaire(questionnaire.id, {
      organizationId,
      caseId,
    });

    return {
      systemQuestionnaire: structure,
      sections: structure?.sections ?? [],
      /*
        Lifted out of the structure so the staff tab reads it in the same place
        the client portal does. A branch is a property of the questionnaire, not
        of whichever nested object happened to be fetched with it.
      */
      logicRules: structure?.logicRules ?? [],
    };
  };

  /**
   * The case questionnaire for one matter — the substantive one that feeds the
   * forms, not the short intake questionnaire the prospect answered before the
   * case existed.
   *
   * Resolves the matter's case type itself so callers pass only a `caseId`, and
   * so a matter can never be shown another case type's questions.
   */
  getCaseQuestionnaire = async (organizationId: string, caseId: string) => {
    const caseTypeId = await this.getCaseTypeIdForCase(organizationId, caseId);
    return this.getMergedQuestionnaire(organizationId, caseTypeId, {
      stage: "case",
      caseId,
    });
  };

  /** The matter's case type, scoped to the firm so it doubles as an access check. */
  getCaseTypeIdForCase = async (organizationId: string, caseId: string) => {
    const [row] = await db
      .select({ caseTypeId: cases.caseTypeId })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!row?.caseTypeId) {
      throw new NotFoundError("Case not found, or it has no case type");
    }
    return row.caseTypeId;
  };

  addSection = async (input: {
    organizationId: string;
    caseTypeId: string;
    scope: FirmScope;
    caseId?: string | null;
    stage?: QuestionnaireStage;
    title: string;
    description?: string | null;
    orderIndex?: number;
  }) => {
    const { questionnaireId, caseId } = await this.resolveWriteTarget(input);

    const [created] = await db
      .insert(questionnaireSections)
      .values({
        questionnaireId,
        scope: input.scope,
        organizationId: input.organizationId,
        caseId,
        title: input.title,
        description: input.description,
        orderIndex:
          input.orderIndex ??
          (await this.nextSectionOrderIndex(
            questionnaireId,
            input.scope,
            caseId,
          )),
      })
      .returning();

    return created;
  };

  /**
   * Edit a section the firm owns.
   *
   * `ownedSection` matches on `organization_id`, which a platform row does not
   * carry — so a firm editing the backbone finds nothing and gets a 404. That
   * used to fall through to a copy-on-write: the edit landed as a firm-scoped
   * duplicate carrying `supersedes_id`, and the merge hid the original for
   * that firm alone.
   *
   * It no longer does. Oravanti authors the questionnaire backbone and a firm
   * extends it — `addSection` and `addQuestion` below are the whole of what a
   * firm may write. See the scope note on `questionnaireScopeEnum`.
   */
  updateSection = async (
    organizationId: string,
    sectionId: string,
    data: { title?: string; description?: string | null; orderIndex?: number },
  ) => {
    const [owned] = await db
      .update(questionnaireSections)
      .set({ ...data, updatedAt: new Date() })
      .where(this.ownedSection(organizationId, sectionId))
      .returning();

    if (!owned) {
      throw new NotFoundError(
        "Section not found, or it is one Oravanti maintains",
      );
    }

    return owned;
  };


  /**
   * Deleting a section takes its questions with it, and their answers after
   * that — the cascade is declared on the foreign keys rather than run by hand
   * here, which is the whole point of consolidating the question tables.
   */
  deleteSection = async (organizationId: string, sectionId: string) => {
    const [deleted] = await db
      .delete(questionnaireSections)
      .where(this.ownedSection(organizationId, sectionId))
      .returning();

    if (!deleted) throw new NotFoundError("Section not found");
  };

  addQuestion = async (
    input: QuestionInput & {
      organizationId: string;
      caseTypeId: string;
      scope: FirmScope;
      caseId?: string | null;
      stage?: QuestionnaireStage;
      sectionId: string;
      orderIndex?: number;
    },
  ) => {
    const { questionnaireId, caseId } = await this.resolveWriteTarget(input);

    // The section may be a system one — adding a question to a standard section
    // is the ordinary case — so this checks visibility, not ownership.
    const [section] = await db
      .select({ id: questionnaireSections.id })
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.id, input.sectionId),
          eq(questionnaireSections.questionnaireId, questionnaireId),
        ),
      )
      .limit(1);
    if (!section) throw new NotFoundError("Section not found");

    const [created] = await db
      .insert(questionnaireQuestions)
      .values({
        questionnaireId,
        sectionId: input.sectionId,
        scope: input.scope,
        organizationId: input.organizationId,
        caseId,
        fieldKey: input.fieldKey ?? null,
        label: input.label,
        description: input.description,
        type: input.type,
        orderIndex:
          input.orderIndex ??
          (await this.nextQuestionOrderIndex(input.sectionId)),
        isRequired: input.isRequired ?? false,
        config: (input.config ?? {}) as JsonObject,
      })
      .returning();

    return created;
  };

  /** Edit a question the firm owns. Mirrors `updateSection` — see its note. */
  updateQuestion = async (
    organizationId: string,
    questionId: string,
    data: Partial<QuestionInput> & { orderIndex?: number },
  ) => {
    const [owned] = await db
      .update(questionnaireQuestions)
      .set({
        ...data,
        config: data.config as JsonObject | undefined,
        updatedAt: new Date(),
      })
      .where(this.ownedQuestion(organizationId, questionId))
      .returning();

    if (!owned) {
      throw new NotFoundError(
        "Question not found, or it is one Oravanti maintains",
      );
    }

    return owned;
  };


  deleteQuestion = async (organizationId: string, questionId: string) => {
    const [deleted] = await db
      .delete(questionnaireQuestions)
      .where(this.ownedQuestion(organizationId, questionId))
      .returning();

    if (!deleted) throw new NotFoundError("Question not found");
  };

  // ── The case questionnaire, as answered ───────────────────────────────────
  //
  // A matter's questionnaire is answered two ways and usually both in turn:
  // staff type what they already know from the file, then send the rest to the
  // client. Both paths write the same one response row per matter, so the
  // forms have a single thing to populate from and nobody has to reconcile two
  // half-answered copies.

  /**
   * The matter's case-stage response, with its answers keyed by question.
   *
   * Null when nobody has answered anything yet — the tab renders the blank
   * questionnaire in that case rather than an error.
   */
  getCaseResponse = async (organizationId: string, caseId: string) => {
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .innerJoin(
        questionnaires,
        eq(questionnaires.id, questionnaireResponses.questionnaireId),
      )
      .where(
        and(
          eq(questionnaireResponses.caseId, caseId),
          eq(questionnaireResponses.organizationId, organizationId),
          eq(questionnaires.stage, "case"),
        ),
      )
      .orderBy(desc(questionnaireResponses.lastSavedAt))
      .limit(1);

    if (!response) return null;

    const row = response.questionnaire_responses;
    const answers = await db
      .select({
        questionId: questionnaireAnswers.questionId,
        value: questionnaireAnswers.value,
        updatedAt: questionnaireAnswers.updatedAt,
      })
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, row.id));

    return { ...row, answers };
  };


  /**
   * The intake answers this matter came from, for reading only.
   *
   * A matter opens because somebody answered the short intake questionnaire
   * weeks earlier, and those answers are the context an attorney wants when
   * they first open the file. They are deliberately not editable here: intake
   * happened, and re-writing it afterwards would misrepresent what the firm
   * knew when it decided to take the case.
   */
  getIntakeResponseForCase = async (organizationId: string, caseId: string) => {
    const [row] = await db
      .select({
        id: questionnaireResponses.id,
        status: questionnaireResponses.status,
        submittedAt: questionnaireResponses.submittedAt,
        leadId: questionnaireResponses.leadId,
      })
      .from(questionnaireResponses)
      .innerJoin(
        questionnaires,
        eq(questionnaires.id, questionnaireResponses.questionnaireId),
      )
      .where(
        and(
          eq(questionnaireResponses.caseId, caseId),
          eq(questionnaireResponses.organizationId, organizationId),
          eq(questionnaires.stage, "intake"),
        ),
      )
      .orderBy(desc(questionnaireResponses.submittedAt))
      .limit(1);

    if (!row) return null;

    // Joined to the questions rather than read from the send's schema snapshot:
    // the snapshot is what the client was shown, but an answer with no question
    // left to label it is not worth rendering, and the join drops it.
    const answers = await db
      .select({
        questionId: questionnaireAnswers.questionId,
        value: questionnaireAnswers.value,
        label: questionnaireQuestions.label,
        type: questionnaireQuestions.type,
        sectionTitle: questionnaireSections.title,
        sectionOrder: questionnaireSections.orderIndex,
        orderIndex: questionnaireQuestions.orderIndex,
      })
      .from(questionnaireAnswers)
      .innerJoin(
        questionnaireQuestions,
        eq(questionnaireQuestions.id, questionnaireAnswers.questionId),
      )
      .innerJoin(
        questionnaireSections,
        eq(questionnaireSections.id, questionnaireQuestions.sectionId),
      )
      .where(eq(questionnaireAnswers.responseId, row.id))
      .orderBy(
        asc(questionnaireSections.orderIndex),
        asc(questionnaireQuestions.orderIndex),
      );

    return { ...row, answers };
  };
  /**
   * Save answers a staff member typed in-house.
   *
   * Upserts onto whichever response the matter already has, including one a
   * client started through a link — a paralegal correcting a client's answer
   * on the phone is the ordinary case, not a conflict. `filledById` is stamped
   * only on a response that has no send behind it, matching the schema's rule
   * that it is set exactly when `questionnaireSendId` is null.
   *
   * Populating the forms afterwards is what makes this worth doing at all, so
   * it runs on every save rather than only on submission: a paralegal filling
   * the questionnaire wants to watch the forms fill in behind them.
   */
  /**
   * The matter's one answer set, created on first use.
   *
   * A matter has exactly one case-stage response for its whole life, and every
   * send, every staff edit and every client save writes to it. Anything else
   * splits a client's answers across rows and leaves the forms reading whichever
   * one a query happened to sort first — which is precisely what used to happen.
   */
  private ensureCaseResponse = async (
    organizationId: string,
    caseId: string,
    filledById?: string,
  ) => {
    const existing = await this.getCaseResponse(organizationId, caseId);
    if (existing) return existing;

    const caseTypeId = await this.getCaseTypeIdForCase(organizationId, caseId);
    const questionnaire = await this.requireCaseQuestionnaire(caseTypeId);

    const [created] = await db
      .insert(questionnaireResponses)
      .values({
        organizationId,
        questionnaireId: questionnaire.id,
        filledById,
        caseId,
        caseTypeId,
        status: "draft",
      })
      .returning();

    return { ...created, answers: [] };
  };

  /**
   * Save answers a staff member typed, as one version.
   *
   * The unit is whatever the caller sends — in practice one section, because
   * the tab has a Save button per section. That is what makes a version mean
   * something a person recognises: "M. Chen saved Beneficiary details, 6
   * answers changed", rather than one version per keystroke.
   */
  saveCaseAnswers = async (
    organizationId: string,
    caseId: string,
    filledById: string | undefined,
    data: {
      status?: "draft" | "submitted";
      answers: AnswerInput[];
      sectionId?: string | null;
    },
  ) => {
    const response = await this.ensureCaseResponse(
      organizationId,
      caseId,
      filledById,
    );

    const result = await commitAnswers({
      organizationId,
      responseId: response.id,
      answers: data.answers,
      actor: "staff",
      actorId: filledById,
      sectionId: data.sectionId ?? null,
    });

    if (data.status && data.status !== response.status) {
      const now = new Date();
      await db
        .update(questionnaireResponses)
        .set({
          status: data.status,
          submittedAt:
            data.status === "submitted" ? (response.submittedAt ?? now) : null,
          updatedAt: now,
        })
        .where(eq(questionnaireResponses.id, response.id));
    }

    const fieldsPopulated = await this.syncForms(
      organizationId,
      caseId,
      response.id,
      filledById,
    );

    return {
      response: await this.getCaseResponse(organizationId, caseId),
      changed: result.changed,
      version: result.version,
      fieldsPopulated,
    };
  };

  /**
   * Carry the matter's answers onto its forms.
   *
   * Always outside the save transaction: filling a form is a consequence of a
   * save, not a condition of one, and a failure here must never be able to lose
   * the answers that caused it.
   */
  private syncForms = async (
    organizationId: string,
    caseId: string,
    responseId: string,
    actorId?: string,
  ) => {
    try {
      const result = await populateCaseForms({
        caseId,
        organizationId,
        updatedById: actorId,
      });
      return (result.filled ?? 0) + (result.updated ?? 0);
    } catch (err) {
      log.failure(LogEvent.QUESTIONNAIRE_FORM_POPULATION_FAILED, err, {
        caseId,
        responseId,
      });
      return 0;
    }
  };

  /**
   * Put one answer back to what it was at some point in the past.
   *
   * Written forward, as a new save, rather than by deleting the revisions after
   * it. History that can be rewritten is not history — and a colleague's
   * correction must not vanish because somebody rolled back past it.
   */
  restoreAnswer = async (
    organizationId: string,
    caseId: string,
    revisionId: string,
    actorId?: string,
  ) => {
    const response = await this.getCaseResponse(organizationId, caseId);
    if (!response) throw new NotFoundError("This matter has no answers yet");

    const [revision] = await db
      .select()
      .from(questionnaireAnswerRevisions)
      .where(
        and(
          eq(questionnaireAnswerRevisions.id, revisionId),
          eq(questionnaireAnswerRevisions.responseId, response.id),
          eq(questionnaireAnswerRevisions.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!revision) throw new NotFoundError("That change is not on this matter");

    const result = await commitAnswers({
      organizationId,
      responseId: response.id,
      answers: [{ questionId: revision.questionId, value: revision.value }],
      actor: "staff",
      actorId,
    });

    const fieldsPopulated = await this.syncForms(
      organizationId,
      caseId,
      response.id,
      actorId,
    );

    log.action(LogEvent.QUESTIONNAIRE_ANSWERS_RESTORED, {
      caseId,
      responseId: response.id,
      scope: "answer",
      revisionId,
    });

    return { changed: result.changed, fieldsPopulated };
  };

  /**
   * Put the whole questionnaire back to how it stood at a chosen save.
   *
   * Also forward-only: the restore is itself a new version, tagged with what it
   * restored, so the list reads "version 9 — restored from version 4" and the
   * intervening work is still there to look at.
   *
   * Answers added after the chosen version are cleared rather than left
   * standing, because "restore to this point" has to mean the questionnaire
   * looks like it did — a leftover answer from later would be neither state.
   */
  restoreVersion = async (
    organizationId: string,
    caseId: string,
    versionId: string,
    actorId?: string,
  ) => {
    const response = await this.getCaseResponse(organizationId, caseId);
    if (!response) throw new NotFoundError("This matter has no answers yet");

    const { version, answers } = await answersFromVersion(
      organizationId,
      versionId,
    );

    if (version.responseId !== response.id) {
      throw new NotFoundError("That version is not on this matter");
    }

    const restoredIds = new Set(answers.map((a) => a.questionId));
    const cleared = response.answers
      .filter((a) => !restoredIds.has(a.questionId))
      .map((a) => ({ questionId: a.questionId, value: null }));

    const result = await commitAnswers({
      organizationId,
      responseId: response.id,
      answers: [...answers, ...cleared],
      actor: "staff",
      actorId,
      restoredFromVersionId: versionId,
    });

    const fieldsPopulated = await this.syncForms(
      organizationId,
      caseId,
      response.id,
      actorId,
    );

    log.action(LogEvent.QUESTIONNAIRE_ANSWERS_RESTORED, {
      caseId,
      responseId: response.id,
      scope: "version",
      versionId,
      changed: result.changed,
    });

    return { changed: result.changed, fieldsPopulated };
  };

  /** The saves made against this matter's questionnaire, newest first. */
  getCaseVersions = async (organizationId: string, caseId: string) => {
    const response = await this.getCaseResponse(organizationId, caseId);
    if (!response) return [];
    return listVersions(organizationId, response.id);
  };

  /** One save, with the answers it changed. */
  getCaseVersion = async (organizationId: string, versionId: string) =>
    getVersion(organizationId, versionId);

  /** One answer's timeline, newest first. */
  getAnswerHistory = async (
    organizationId: string,
    caseId: string,
    questionId: string,
  ) => {
    const response = await this.getCaseResponse(organizationId, caseId);
    if (!response) return [];
    return listAnswerRevisions(organizationId, response.id, questionId);
  };

  /**
   * Send the case questionnaire to the matter's client.
   *
   * Deliberately smaller than the intake send in `leads.service`: the recipient
   * is already known, there is no pipeline stage to advance, and no custom
   * questions are authored here — those are added to the questionnaire itself
   * and are therefore already in the snapshot below.
   */
  sendCaseQuestionnaire = async (
    organizationId: string,
    caseId: string,
    sentById: string | undefined,
    config: {
      sectionIds?: string[];
      autoReminderDays?: number | null;
      language?: string;
      dueInDays?: number | null;
      reason?: "new" | "correction" | "attention";
      reasonNote?: string | null;
    } = {},
  ) => {
    const [matter] = await db
      .select({
        id: cases.id,
        clientId: cases.clientId,
        caseTypeId: cases.caseTypeId,
      })
      .from(cases)
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
      .limit(1);

    if (!matter) throw new NotFoundError("Case not found");
    if (!matter.clientId) {
      throw new BadRequestError(
        "This matter has no client on it, so there is nobody to send the questionnaire to",
      );
    }
    if (!matter.caseTypeId) {
      throw new BadRequestError("This matter has no case type");
    }

    const structure = await this.buildQuestionnaire(
      (
        await this.requireCaseQuestionnaire(matter.caseTypeId)
      ).id,
      { organizationId, caseId },
    );

    if (!structure) throw new NotFoundError("Case questionnaire not found");

    // A send captures what the client was actually asked. Narrowing to chosen
    // sections happens here, once, rather than being re-derived every time the
    // link is opened — the questionnaire may be edited in the meantime.
    const chosen = config.sectionIds?.length
      ? structure.sections.filter((s) => config.sectionIds!.includes(s.id))
      : structure.sections;

    if (chosen.length === 0) {
      throw new BadRequestError("Select at least one section to send");
    }

    const snapshot = {
      id: structure.id,
      title: structure.title,
      description: structure.description,
      sections: chosen.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        scope: section.scope,
        questions: section.questions.map((q) => ({
          id: q.id,
          label: q.label,
          description: q.description,
          type: q.type,
          isRequired: q.isRequired,
          config: q.config,
          scope: q.scope,
        })),
      })),
      /*
        The rules travel with the questions, because both halves are needed to
        know what the client was asked. A snapshot of questions alone makes
        every branch look unconditional on the day it is read back — which is
        exactly when submission validation demands an answer to something
        nobody saw.
      */
      logicRules: structure.logicRules,
    };

    // Sending is a request for input, so it reopens a questionnaire staff had
    // marked complete. Without this the client followed their link straight to
    // "thank you, already submitted" — a dead end nobody could see from the
    // firm's side, since pressing Send is exactly the act of saying the client
    // should be able to answer.
    await this.reopenForSending(organizationId, caseId, sentById);

    const accessToken = generateAccessToken();
    const dueInDays = config.dueInDays ?? null;

    const [send] = await db
      .insert(questionnaireSends)
      .values({
        organizationId,
        questionnaireId: structure.id,
        clientId: matter.clientId,
        caseId,
        caseTypeId: matter.caseTypeId,
        sentById,
        reason: config.reason ?? "new",
        reasonNote: config.reasonNote?.trim() || null,
        accessTokenHash: tokenHash(accessToken),
        schemaSnapshot: snapshot as unknown as JsonObject,
        deliveryChannels: ["email"],
        language: config.language ?? "english",
        autoReminderDays:
          config.autoReminderDays && config.autoReminderDays > 0
            ? config.autoReminderDays
            : null,
        expiresAt: dueInDays
          ? new Date(Date.now() + dueInDays * 24 * 60 * 60 * 1000)
          : null,
      })
      .returning();

    const baseUrl = env.FRONTEND_APP_URL ?? "http://localhost:5173";
    const clientLink = `${baseUrl}/questionnaire/${encodeURIComponent(
      organizationId,
    )}/${accessToken}`;

    void notify({
      organizationId,
      event: "questionnaire_sent",
      recipients: [{ type: "client", id: matter.clientId }],
      context: {
        link: clientLink,
        reason: config.reason ?? "new",
        reasonNote: config.reasonNote?.trim() || null,
      },
      channels: ["email"],
      scenario: { caseId, clientId: matter.clientId },
      actorStaffId: sentById,
      dedupeKey: `questionnaire-sent-${send.id}`,
    }).catch((err: unknown) =>
      log.failure(LogEvent.NOTIFICATION_DISPATCH_FAILED, err, {
        caseId,
        event: "questionnaire_sent",
      }),
    );

    return { send, clientLink, sectionsSent: chosen.length };
  };

  /**
   * Put a completed questionnaire back to draft so a client can answer it.
   *
   * Recorded as a version like any other change of hands, because "who reopened
   * this, and when" is exactly the kind of question a completed-then-reopened
   * questionnaire invites. No answers move — only the status.
   */
  private reopenForSending = async (
    organizationId: string,
    caseId: string,
    actorId?: string,
  ) => {
    const response = await this.getCaseResponse(organizationId, caseId);
    if (!response || response.status !== "submitted") return;

    await db
      .update(questionnaireResponses)
      .set({ status: "draft", submittedAt: null, updatedAt: new Date() })
      .where(eq(questionnaireResponses.id, response.id));

    log.action(LogEvent.QUESTIONNAIRE_REOPENED, {
      caseId,
      responseId: response.id,
      staffId: actorId,
    });
  };

  /** The case-stage questionnaire for a case type, or a 404 explaining which. */
  private requireCaseQuestionnaire = async (caseTypeId: string) => {
    const [questionnaire] = await db
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.caseTypeId, caseTypeId),
          eq(questionnaires.stage, "case"),
        ),
      )
      .limit(1);

    if (!questionnaire) {
      throw new NotFoundError(
        "No case questionnaire exists for this matter's case type",
      );
    }
    return questionnaire;
  };

  // ── Responses ─────────────────────────────────────────────────────────────

  getResponses = async (
    organizationId: string,
    questionnaireId: string,
    filters: Partial<PaginationParams> & { caseTypeId?: string } = {},
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });
    const conditions = [
      eq(questionnaireResponses.organizationId, organizationId),
      eq(
        questionnaireResponses.questionnaireId,
        questionnaireId,
      ),
    ];

    if (filters.caseTypeId) {
      conditions.push(
        eq(questionnaireResponses.caseTypeId, filters.caseTypeId),
      );
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

  getEligibleQuestionnairesForCase = async (
    organizationId: string,
    caseId: string,
  ) => {
    const [caseRow] = await db
      .select()
      .from(cases)
      .where(
        and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)),
      )
      .limit(1);

    if (!caseRow) throw new NotFoundError("Case not found");
    if (!caseRow.caseTypeId) return null;

    return this.getSystemQuestionnaireByCaseType(caseRow.caseTypeId);
  };

  // ── Token-Based Client Flow ────────────────────────────────────────────────

  getClientQuestionnaireByToken = async (accessToken: string) => {
    const send = await this.getActiveSendByToken(accessToken, true);

    return {
      send,
      questionnaire: await this.clientSchemaForSend(send),
      response: await this.clientResponseForSend(send),
    };
  };

  /**
   * What the client is shown, which is not always what the send recorded.
   *
   * For a **case** send the questionnaire is rebuilt live and narrowed to the
   * sections that were sent. A snapshot froze the wording at the moment the
   * link went out, so a typo staff fixed an hour later never reached the
   * client and a question added to a sent section was invisible until somebody
   * re-sent — and re-sending is what used to strand the answers. The send still
   * decides the *scope*; the questionnaire decides the *content*.
   *
   * A superseding copy is followed through, so a firm rewording a seeded
   * section after sending does not make that section vanish from the link.
   *
   * For an **intake** send the snapshot stands. It is not a view of a stored
   * questionnaire at all: the custom questions a paralegal wrote into that one
   * send exist nowhere else, so rebuilding would lose them.
   */
  private clientSchemaForSend = async (
    send: typeof questionnaireSends.$inferSelect,
  ) => {
    if (!send.caseId) return send.schemaSnapshot;

    const live = await this.buildQuestionnaire(send.questionnaireId, {
      organizationId: send.organizationId,
      caseId: send.caseId,
    });
    if (!live) return send.schemaSnapshot;

    const snapshot = send.schemaSnapshot as {
      sections?: { id: string }[];
    } | null;
    const sentIds = new Set(
      (snapshot?.sections ?? []).map((section) => section.id),
    );

    // Matched by id alone. This used to also admit a section whose
    // `supersedesId` was in the snapshot, so a firm editing a platform section
    // after the send did not drop it from the client's copy. Nothing is
    // superseded any more, so an id is an id.
    const sections = live.sections.filter((section) => sentIds.has(section.id));

    return {
      id: live.id,
      title: live.title,
      description: live.description,
      // A send that somehow matches nothing live falls back to every section
      // rather than showing the client an empty questionnaire.
      sections: sections.length > 0 ? sections : live.sections,
      // Rebuilt live like the questions, and for the same reason: a rule added
      // after the link went out is one the client should be branching on.
      logicRules: live.logicRules,
    };
  };

  /**
   * The answers a client's link should open with.
   *
   * For a case send that is the matter's one answer set — everything staff have
   * typed and everything the client said on any earlier link — so a client
   * reviews and corrects rather than starting from blank. Reading this by
   * `send.id` is what left them staring at an empty form: the answers were
   * always there, on the response the previous send had created.
   */
  private clientResponseForSend = async (
    send: typeof questionnaireSends.$inferSelect,
  ) => {
    if (!send.caseId) return this.getResponseForSend(send.id);

    const response = await this.getCaseResponse(send.organizationId, send.caseId);
    if (!response) return null;

    const files = await responseFilesQuery().where(
      eq(questionnaireResponseFiles.responseId, response.id),
    );

    return { ...response, files: await presignResponseFiles(files) };
  };

  saveDraftResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionId?: string | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    const result = await this.saveResponse(send, {
      status: "draft",
      currentSectionId: data.currentSectionId,
      answers: data.answers ?? [],
    });

    if (send.leadId) {
      await logLeadEvent({
        organizationId: send.organizationId,
        leadId: send.leadId,
        action: "lead.questionnaire_draft_saved",
        metadata: { sendId: send.id },
      });
    }

    return result;
  };

  submitResponseByToken = async (
    accessToken: string,
    data: {
      currentSectionId?: string | null;
      answers?: AnswerInput[];
    },
  ) => {
    const send = await this.getActiveSendByToken(accessToken);
    const result = await this.saveResponse(send, {
      status: "submitted",
      currentSectionId: data.currentSectionId,
      answers: data.answers ?? [],
    });

    // Response is in — cancel the pending auto-reminder so it never fires.
    if (send.reminderJobId) {
      await cancelQuestionnaireReminder(send.reminderJobId).catch(
        (err) => log.failure("queue.job_cancel_failed", err, { questionnaireId: send.id }),
      );
    }

    if (send.leadId) {
      await logLeadEvent({
        organizationId: send.organizationId,
        leadId: send.leadId,
        action: "lead.questionnaire_response_received",
        metadata: { sendId: send.id, responseId: result!.id },
      });
    }

    return result;
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

    const file = await this.persistResponseFile({
      organizationId: send.organizationId,
      responseId: response.id,
      leadId: send.leadId ?? null,
      questionId: data.questionId,
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      originalFilename: data.originalFilename,
    });

    if (send.leadId) {
      await logLeadEvent({
        organizationId: send.organizationId,
        leadId: send.leadId,
        action: "lead.questionnaire_file_uploaded",
        metadata: {
          sendId: send.id,
          responseId: response.id,
          questionId: data.questionId,
          filename: data.originalFilename,
          documentId: file.documentId,
          versionNumber: file.versionNumber,
        },
      });
    }

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

    const send = await this.sendForResponse(response.questionnaireSendId);

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

    return this.persistResponseFile({
      organizationId,
      responseId: response.id,
      leadId: send?.leadId ?? null,
      questionId: data.questionId,
      storagePath,
      fileBuffer: data.fileBuffer,
      mimeType: data.mimeType,
      fileSize: data.fileSize,
      originalFilename: data.originalFilename,
    });
  };

  /**
   * Persist an uploaded response file as a first-class document.
   *
   * The bytes are already in storage by this point. Here the file becomes a
   * `documents` + `document_versions` pair (checksummed, so the AI analysis
   * cache can key on it), gets linked to the lead, and is joined back to the
   * question that asked for it. Re-answering the same question appends a
   * VERSION to the existing document rather than minting a second document —
   * which is what makes "re-uploaded ⇒ re-run the AI" work without a flag.
   */
  private persistResponseFile = async (input: {
    organizationId: string;
    responseId: string;
    leadId: string | null;
    questionId: string;
    storagePath: string;
    fileBuffer: Buffer;
    mimeType: string;
    fileSize: number;
    originalFilename: string;
  }) => {
    const checksum = computeChecksum(input.fileBuffer);

    const result = await withTransaction(db, async () => {
      const [existing] = await db
        .select({
          id: questionnaireResponseFiles.id,
          documentId: questionnaireResponseFiles.documentId,
        })
        .from(questionnaireResponseFiles)
        .where(
          and(
            eq(questionnaireResponseFiles.responseId, input.responseId),
            eq(questionnaireResponseFiles.questionId, input.questionId),
          ),
        )
        .limit(1);

      // The platform's own questions are the ones that ask for identity
      // documents; anything a firm or a matter added is supporting material.
      // Read off the question rather than a snapshot — a real foreign key means
      // it is always there to read.
      const [question] = await db
        .select({ scope: questionnaireQuestions.scope })
        .from(questionnaireQuestions)
        .where(eq(questionnaireQuestions.id, input.questionId))
        .limit(1);

      const ingestInput = {
        organizationId: input.organizationId,
        storagePath: input.storagePath,
        originalFileName: input.originalFilename,
        mimeType: input.mimeType,
        fileSize: input.fileSize,
        checksum,
        category:
          question?.scope === "system"
            ? ("identity" as const)
            : ("supporting" as const),
      };

      // Re-answer → new version on the same document; first answer → new document.
      const ingested = existing
        ? await addDocumentVersion(existing.documentId, ingestInput)
        : await ingestDocument({ ...ingestInput, leadId: input.leadId });

      const [joinRow] = existing
        ? [{ ...existing, questionId: input.questionId }]
        : await db
            .insert(questionnaireResponseFiles)
            .values({
              organizationId: input.organizationId,
              responseId: input.responseId,
              documentId: ingested.documentId,
              questionId: input.questionId,
            })
            .returning();

      // Satisfy the matching requirement, if this question produced one.
      if (input.leadId) {
        await db
          .update(scenarioDocumentRequirements)
          .set({
            satisfiedByDocumentId: ingested.documentId,
            satisfiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scenarioDocumentRequirements.leadId, input.leadId),
              eq(
                scenarioDocumentRequirements.questionnaireQuestionId,
                input.questionId,
              ),
            ),
          );
      }

      return { joinRow, ingested };
    });

    // Scan the lead once the upload is committed. Fire-and-forget: a scan is a
    // side effect, never a precondition for the upload succeeding. Coalescing
    // collapses a burst of question uploads into one scan.
    if (input.leadId) {
      triggerScenarioScan({
        organizationId: input.organizationId,
        scenarioType: "lead",
        scenarioId: input.leadId,
        trigger: "upload",
      });
    }

    return {
      id: result.joinRow.id,
      responseId: input.responseId,
      questionId: input.questionId,
      documentId: result.ingested.documentId,
      documentVersionId: result.ingested.documentVersionId,
      versionNumber: result.ingested.versionNumber,
      storagePath: input.storagePath,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      checksum,
    };
  };

  /**
   * Get all questionnaire response files linked to a lead, with what AI review
   * makes of each. Used by the lead documents tab.
   */
  getFilesByLeadId = async (leadId: string, organizationId: string) => {
    // Lead linkage now lives on lead_document_links rather than on the join row.
    const files = await db
      .select(responseFileColumns)
      .from(questionnaireResponseFiles)
      .innerJoin(
        documents,
        eq(documents.id, questionnaireResponseFiles.documentId),
      )
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, documents.currentVersionId),
      )
      .innerJoin(
        leadDocumentLinks,
        eq(leadDocumentLinks.documentId, questionnaireResponseFiles.documentId),
      )
      .innerJoin(leads, eq(leads.id, leadDocumentLinks.leadId))
      .where(
        and(
          eq(leadDocumentLinks.leadId, leadId),
          // This query previously had no tenancy predicate: any signed-in staff
          // member could read another firm's intake documents by lead id.
          eq(leads.organizationId, organizationId),
          isNull(leadDocumentLinks.archivedAt),
        ),
      )
      .orderBy(desc(questionnaireResponseFiles.createdAt));

    const flags = await flagsByDocument(
      organizationId,
      files.map((f) => f.documentId),
    );
    const presigned = await presignResponseFiles(files);

    return presigned.map((file) => ({
      ...file,
      aiReview: {
        status: file.aiScanStatus,
        flags: flags.get(file.documentId) ?? [],
      },
    }));
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
        caseTypeId: leads.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        conflictStatus: conflictChecks.status,
        supervisorOverrideById: conflictChecks.supervisorOverrideById,
      })
      .from(leads)
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, leads.caseTypeId),
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
        caseTypeId: questionnaires.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        questionnaireTitle: questionnaires.title,
        questionLabel: questionnaireQuestions.label,
        questionType: questionnaireQuestions.type,
        questionDescription: questionnaireQuestions.description,
        orderIndex: questionnaireQuestions.orderIndex,
      })
      .from(questionnaireQuestions)
      .innerJoin(
        questionnaires,
        eq(
          questionnaires.id,
          questionnaireQuestions.questionnaireId,
        ),
      )
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, questionnaires.caseTypeId),
      )
      .orderBy(asc(questionnaireQuestions.orderIndex));

    const grouped = new Map<
      string,
      {
        caseTypeId: string;
        caseTypeName: string | null;
        questions: {
          label: string;
          type: string;
          description: string | null;
        }[];
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
  getResponseDetailById = async (
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

    const send = await this.sendForResponse(response.questionnaireSendId);

    const answers = await db
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));

    const files = await responseFilesQuery().where(
      eq(questionnaireResponseFiles.responseId, response.id),
    );

    const completion = computeCompletion(send?.schemaSnapshot, answers, files);

    // What AI review makes of each uploaded document. `aiScanStatus` alone
    // cannot say whether a scanned document was fine or was never looked at, so
    // both travel together.
    const flags = await flagsByDocument(
      organizationId,
      files.map((f) => f.documentId),
    );
    const presigned = await presignResponseFiles(files);

    return {
      response,
      send,
      answers,
      files: presigned.map((file) => ({
        ...file,
        aiReview: {
          status: file.aiScanStatus,
          flags: flags.get(file.documentId) ?? [],
        },
      })),
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

    const send = await this.sendForResponse(response.questionnaireSendId);

    const answers = await db
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));
    const files = await responseFilesQuery().where(
      eq(questionnaireResponseFiles.responseId, response.id),
    );

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
        .where(
          and(
            eq(leads.id, response.leadId),
            eq(leads.organizationId, organizationId),
          ),
        );

      await logLeadEvent({
        organizationId,
        leadId: response.leadId,
        action: "lead.stage_changed",
        metadata: { from: "questionnaire", to: "consultation" },
      });
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
      doc
        .moveDown(0.5)
        .fontSize(13)
        .fillColor("#1a1a1a")
        .text(section.title ?? "Section");
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
    const [file] = await responseFilesQuery()
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

    if (send.leadId) {
      await logLeadEvent({
        organizationId,
        leadId: send.leadId,
        action: "lead.reminder_sent",
        metadata: { sendId: send.id, channel: "questionnaire_reminder" },
      });
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
        const channels = ((send.deliveryChannels as string[] | null) ?? [
          "email",
        ]) as ("email" | "sms")[];

        void notify({
          organizationId,
          event: "missing_documents_requested",
          recipients: [{ type: "lead", id: lead.id }],
          // No link: this flow does not mint a fresh access token, so it can
          // only point the lead at the one they already hold.
          context: { documents: missing },
          channels,
          scenario: { leadId: lead.id },
          // Keyed on the outstanding set, so chasing the same documents twice
          // is idempotent while a shorter list after a partial upload sends.
          dedupeKey: `missing-docs-${sendId}-${missing.length}`,
        }).catch((err: unknown) =>
          log.failure(LogEvent.NOTIFICATION_DISPATCH_FAILED, err, {
            leadId: send.leadId!,
            event: "missing_documents_requested",
          }),
        );
      }
    }

    if (send.leadId && missing.length > 0) {
      await logLeadEvent({
        organizationId,
        leadId: send.leadId,
        action: "lead.missing_documents_requested",
        metadata: { sendId: send.id, missingCount: missing.length, missing },
      });
    }

    return { missing };
  };

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Assemble a questionnaire from every tier the caller is entitled to see.
   *
   * With no `visibility`, that is the system backbone alone — what a platform
   * admin edits, and what the seeds write. With one, it additionally admits the
   * firm's own sections and questions, and those written for a single matter.
   *
   * Ordering is `scope` first, then `orderIndex`: the platform's questions keep
   * their authored sequence, the firm's follow, and anything written for this
   * matter comes last. That is the order the two-table version produced by
   * concatenating its arrays, now stated once as a sort rather than implied by
   * the shape of the merge.
   */
  private buildQuestionnaire = async (
    id: string,
    visibility?: { organizationId: string; caseId?: string | null },
  ) => {
    const [questionnaire] = await db
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.id, id))
      .limit(1);

    if (!questionnaire) return null;

    // A row is visible when it is the platform's, or this firm's and either not
    // tied to a matter or tied to *this* one. Another matter's questions stay
    // out even though the firm owns them.
    const visible = (col: {
      organizationId: PgColumn;
      caseId: PgColumn;
    }) => {
      if (!visibility) return isNull(col.organizationId);
      return and(
        or(
          isNull(col.organizationId),
          eq(col.organizationId, visibility.organizationId),
        ),
        visibility.caseId
          ? or(isNull(col.caseId), eq(col.caseId, visibility.caseId))
          : isNull(col.caseId),
      );
    };

    const [sections, questions, logicRules] = await Promise.all([
      db
        .select()
        .from(questionnaireSections)
        .where(
          and(
            eq(questionnaireSections.questionnaireId, id),
            visible(questionnaireSections),
          ),
        ),
      db
        .select()
        .from(questionnaireQuestions)
        .where(
          and(
            eq(questionnaireQuestions.questionnaireId, id),
            visible(questionnaireQuestions),
          ),
        ),
      db
        .select()
        .from(questionnaireLogicRules)
        .where(
          and(
            eq(questionnaireLogicRules.questionnaireId, id),
            visible(questionnaireLogicRules),
          ),
        )
        .orderBy(asc(questionnaireLogicRules.priority)),
    ]);

    // There is no supersession step here any more.
    //
    // A firm's edit of a platform row used to be stored as a copy pointing
    // back at the original, and this is where the original was dropped and its
    // questions re-pointed at the copy. A firm no longer edits the backbone —
    // it extends it — so every row read here is exactly one row, and
    // `isLocked` is simply whose it is.
    const questionsBySection = new Map<
      string,
      ((typeof questions)[number] & { isLocked: boolean })[]
    >();
    for (const q of [...questions].sort(byScopeThenOrder)) {
      const arr = questionsBySection.get(q.sectionId) ?? [];
      arr.push({ ...q, isLocked: q.scope === "system" });
      questionsBySection.set(q.sectionId, arr);
    }

    return {
      ...questionnaire,
      sections: [...sections].sort(byScopeThenOrder).map((s) => ({
        ...s,
        isLocked: s.scope === "system",
        questions: questionsBySection.get(s.id) ?? [],
      })),
      logicRules,
    };
  };

  /**
   * Resolve which questionnaire a firm-scope or per-matter write lands on, and
   * validate the `caseId` against the scope, so every writer below gets the
   * same answer to "is this request coherent?".
   */
  private resolveWriteTarget = async (input: {
    caseTypeId: string;
    scope: FirmScope;
    caseId?: string | null;
    stage?: QuestionnaireStage;
  }) => {
    const caseId = input.caseId ?? null;

    if (input.scope === "case" && !caseId) {
      throw new BadRequestError("A caseId is required for case-scoped content");
    }
    if (input.scope === "firm" && caseId) {
      throw new BadRequestError(
        "Firm-scoped content applies to every matter and cannot name one",
      );
    }

    await this.ensureCaseTypeExists(input.caseTypeId);

    // Per-matter questions only ever belong on the case questionnaire; firm
    // additions default to intake, which is where they have always gone.
    const stage: QuestionnaireStage =
      input.stage ?? (input.scope === "case" ? "case" : "intake");

    const [questionnaire] = await db
      .select({ id: questionnaires.id })
      .from(questionnaires)
      .where(
        and(
          eq(questionnaires.caseTypeId, input.caseTypeId),
          eq(questionnaires.stage, stage),
        ),
      )
      .limit(1);

    if (!questionnaire) {
      throw new NotFoundError(
        `No ${stage} questionnaire exists for this case type`,
      );
    }

    return { questionnaireId: questionnaire.id, caseId };
  };

  /**
   * The write guard, and the reason `system` rows are safe in the same table:
   * matching on a non-null `organizationId` can never select one, so a firm
   * cannot edit or delete the platform's questions through any of these
   * methods. Database policy enforces the same rule a second time — see
   * `rls_questionnaire_sections_org`.
   */
  private ownedSection = (organizationId: string, sectionId: string) =>
    and(
      eq(questionnaireSections.id, sectionId),
      eq(questionnaireSections.organizationId, organizationId),
    );

  private ownedQuestion = (organizationId: string, questionId: string) =>
    and(
      eq(questionnaireQuestions.id, questionId),
      eq(questionnaireQuestions.organizationId, organizationId),
    );

  /*
    The platform's own rows: the inverse of `ownedSection`/`ownedQuestion`.

    A NULL `organization_id` is what makes a row Oravanti's, and it is also
    what stops a tenant connection writing it — the same fact enforced twice,
    once in the query and once in database policy. `isNull` rather than a check
    on `scope` because the column that decides the RLS outcome is the one worth
    matching on; the two agree, and if they ever did not, this is the one that
    would still be right.
  */
  private platformSection = (sectionId: string) =>
    and(
      eq(questionnaireSections.id, sectionId),
      isNull(questionnaireSections.organizationId),
    );

  private platformQuestion = (questionId: string) =>
    and(
      eq(questionnaireQuestions.id, questionId),
      isNull(questionnaireQuestions.organizationId),
    );

  /**
   * The send a response arrived through, if it arrived through one.
   *
   * Undefined for a response staff filled in-house, which has no link, no
   * token and no schema snapshot. Every caller already treats the send as
   * optional — this makes the nullability explicit in one place instead of
   * three lookups that quietly assumed it was always there.
   */
  private sendForResponse = async (sendId: string | null) => {
    if (!sendId) return undefined;
    const [send] = await db
      .select()
      .from(questionnaireSends)
      .where(eq(questionnaireSends.id, sendId))
      .limit(1);
    return send;
  };

  private ensureCaseTypeExists = async (caseTypeId: string) => {
    const [ct] = await db
      .select()
      .from(practiceAreaCaseTypes)
      .where(eq(practiceAreaCaseTypes.id, caseTypeId))
      .limit(1);
    if (!ct) throw new BadRequestError("Case type not found");
    return ct;
  };

  /** Next free slot at the end of this tier's own run of sections. */
  private nextSectionOrderIndex = async (
    questionnaireId: string,
    scope: QuestionnaireScope,
    caseId: string | null,
  ) => {
    const [{ total }] = await db
      .select({ total: count() })
      .from(questionnaireSections)
      .where(
        and(
          eq(questionnaireSections.questionnaireId, questionnaireId),
          eq(questionnaireSections.scope, scope),
          caseId
            ? eq(questionnaireSections.caseId, caseId)
            : isNull(questionnaireSections.caseId),
        ),
      );
    return Number(total);
  };

  /**
   * Questions are numbered per section across all scopes, not per scope: a firm
   * question added to a system section has to sort after the system ones, and
   * `byScopeThenOrder` only breaks ties it is given distinctly.
   */
  private nextQuestionOrderIndex = async (sectionId: string) => {
    const [{ total }] = await db
      .select({ total: count() })
      .from(questionnaireQuestions)
      .where(eq(questionnaireQuestions.sectionId, sectionId));
    return Number(total);
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
    if (send.status === "revoked")
      throw new ConflictError("Questionnaire send has been revoked");
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

  private getResponseForSend = async (sendId: string) => {
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.questionnaireSendId, sendId))
      .limit(1);

    if (!response) return null;

    const answers = await db
      .select()
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, response.id));

    const files = await responseFilesQuery().where(
      eq(questionnaireResponseFiles.responseId, response.id),
    );

    return { ...response, answers, files: await presignResponseFiles(files) };
  };

  private ensureResponseForSend = async (
    responseId: string,
    sendId: string,
    organizationId: string,
  ) => {
    const [response] = await db
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

  /**
   * A client saving progress, or submitting.
   *
   * ─── Which response this writes to ──────────────────────────────────────────
   *
   * For a **case** questionnaire, the matter's one answer set — never a fresh
   * row per send. Sending the questionnaire a second time used to create a
   * second response with nothing in it, so the client started from blank, their
   * earlier answers were stranded, and the forms read whichever row a query
   * happened to sort first. A send is a delivery, not a new questionnaire; the
   * answers belong to the matter and outlive it.
   *
   * For an **intake** questionnaire there is no matter yet, so the response
   * stays tied to its send exactly as before.
   *
   * Both routes write through `commitAnswers`, which is what gives every save —
   * client or staff — a version and a per-answer change log.
   */
  private saveResponse = async (
    send: typeof questionnaireSends.$inferSelect,
    data: {
      status: "draft" | "submitted";
      currentSectionId?: string | null;
      answers: AnswerInput[];
    },
  ) => {
    const response = await this.responseForSave(send);

    if (response.status === "submitted") {
      throw new ConflictError("Client has already submitted a response");
    }

    if (data.status === "submitted") {
      // Validated against everything on file, not just this request: a client
      // answering the last section must satisfy the required questions from the
      // earlier ones too.
      const merged = new Map<string, unknown>();
      for (const answer of response.answers ?? []) {
        merged.set(answer.questionId, answer.value);
      }
      for (const answer of data.answers) {
        merged.set(answer.questionId, answer.value);
      }
      // Against what the client was actually shown, which for a case send is
      // the live questionnaire. Validating against the snapshot would demand an
      // answer to a question staff had since deleted, and let a newly required
      // one through unanswered.
      const schema = await this.clientSchemaForSend(send);
      const mergedAnswers = Array.from(merged.entries()).map(
        ([questionId, value]) => ({ questionId, value }),
      );
      validateSubmissionAnswers(schema, mergedAnswers);

      /*
        An answer inside a branch the client collapsed is withdrawn, and this is
        where it goes.

        A client who answers "Yes, I was married before", names an ex-spouse,
        then changes the answer to "No" has told us there is no ex-spouse. The
        row is still in the table, and nothing downstream would ever ask why —
        `populateCaseForms` matches on field key and would print the name on the
        I-130. Cleared at submission rather than at every keystroke, because a
        client toggling back and forth mid-sitting must not lose their typing.

        Through `commitAnswers` with the rest, so the withdrawal gets a version
        and shows in the answer history like any other change. Silently deleting
        something a client typed is not a thing to do without a record.
      */
      const withdrawn = hiddenInSchema(schema, mergedAnswers);
      for (const questionId of withdrawn) {
        if (!isEmptyAnswer(merged.get(questionId))) {
          data.answers = [...data.answers, { questionId, value: null }];
        }
      }
    }

    await commitAnswers({
      organizationId: send.organizationId,
      responseId: response.id,
      answers: data.answers,
      actor: "client",
      sectionId: data.currentSectionId ?? null,
    });

    const now = new Date();
    await db
      .update(questionnaireResponses)
      .set({
        status: data.status,
        currentSectionId: data.currentSectionId,
        lastSavedAt: now,
        submittedAt: data.status === "submitted" ? now : null,
        updatedAt: now,
      })
      .where(eq(questionnaireResponses.id, response.id));

    await db
      .update(questionnaireSends)
      .set({
        status: data.status === "submitted" ? "submitted" : "draft_response",
        submittedAt: data.status === "submitted" ? now : null,
        updatedAt: now,
      })
      .where(eq(questionnaireSends.id, send.id));

    // Every save, not only submission.
    //
    // A client who answers half the questionnaire and closes the tab has still
    // told the firm half of what it needed. Waiting for a submit that may never
    // come left the forms reading "not started" while their answers sat in the
    // database. `populateCaseForms` is safe to repeat and never overwrites a
    // hand edit, so running it on drafts costs nothing and makes partial
    // progress visible where the work happens.
    //
    // Outside any transaction, and failure is logged rather than raised: the
    // client has done their part and their answers are saved.
    if (send.caseId) {
      await this.syncForms(send.organizationId, send.caseId, response.id);
    }

    return this.getResponseById(response.id);
  };

  /**
   * The response a client's save should land on, created if this is the first.
   *
   * The case branch also re-points the response at the send that is currently
   * delivering it, so "which link did they last answer through" stays
   * answerable while the answers themselves stay put.
   */
  private responseForSave = async (
    send: typeof questionnaireSends.$inferSelect,
  ) => {
    if (send.caseId) {
      const response = await this.ensureCaseResponse(
        send.organizationId,
        send.caseId,
      );

      if (response.questionnaireSendId !== send.id) {
        await db
          .update(questionnaireResponses)
          .set({ questionnaireSendId: send.id, updatedAt: new Date() })
          .where(eq(questionnaireResponses.id, response.id));
      }

      return response;
    }

    const existing = await this.getResponseForSend(send.id);
    if (existing) return existing;

    const [created] = await db
      .insert(questionnaireResponses)
      .values({
        organizationId: send.organizationId,
        questionnaireSendId: send.id,
        questionnaireId: send.questionnaireId,
        leadId: send.leadId,
        clientId: send.clientId,
        caseId: send.caseId,
        caseTypeId: send.caseTypeId,
        status: "draft",
      })
      .returning();

    return { ...created, answers: [] };
  };

  /** One response with its answers, by id. */
  private getResponseById = async (responseId: string) => {
    const [response] = await db
      .select()
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.id, responseId))
      .limit(1);

    if (!response) throw new NotFoundError("Response not found");

    const answers = await db
      .select({
        questionId: questionnaireAnswers.questionId,
        value: questionnaireAnswers.value,
      })
      .from(questionnaireAnswers)
      .where(eq(questionnaireAnswers.responseId, responseId));

    return { ...response, answers };
  };
}
