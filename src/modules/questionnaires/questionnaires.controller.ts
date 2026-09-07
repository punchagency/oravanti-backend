import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import type { QuestionnaireStage } from "../../db/schema/questionnaires";
import type { AuditActionName } from "../../lib/audit/actions";
import { recordAuditEvent } from "../shared/audit.service";
import { fieldVocabulary } from "../workflow/form-catalogue.service";
import { QuestionnairesService } from "./questionnaires.service";

/**
 * Records a change to the questionnaire backbone.
 *
 * `organizationId: null` because the change belongs to no firm — one of these
 * alters what every firm's clients are asked. Filing it under whichever tenant
 * happened to be in context would hide exactly that; a platform request has no
 * tenant in context anyway, and this makes the absence deliberate rather than
 * incidental. Mirrors the helper in `platform.controller.ts`.
 */
const auditPlatform = (
  action: AuditActionName,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {},
) =>
  recordAuditEvent({
    action,
    entityId,
    organizationId: null,
    summary,
    metadata,
  });

export class QuestionnairesController {
  private svc: QuestionnairesService;

  constructor(questionnairesService: QuestionnairesService) {
    this.svc = questionnairesService;
  }

  /**
   * What a question can be wired to.
   *
   * One handler behind two routes — a firm's and the platform's — because the
   * answer is the same catalogue either way. The guards differ, and that is
   * the only thing that does: a firm admin naming one of its own questions and
   * an operator naming one of Oravanti's are both choosing from what the
   * forms actually print.
   */
  getFieldVocabulary = asyncWrap(async (_req: Request, res: Response) => {
    const fields = await fieldVocabulary();
    sendSuccess(res, fields, "Form field vocabulary retrieved successfully");
  });

  // System Questionnaire Read

  getSystemQuestionnaires = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.getSystemQuestionnaires(req.query as never);
    sendSuccess(res, result, "System questionnaires retrieved successfully");
  });

  getSystemQuestionnaireByCaseType = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireByCaseType(req.params.caseTypeId as string);
    if (!result) throw new NotFoundError("Questionnaire not found for this case type");
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  getSystemQuestionnaireById = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireById(req.params.id as string);
    if (!result) throw new NotFoundError("Questionnaire not found");
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  // System Questionnaire Management (admin only)

  createSystemQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const { caseTypeId, stage, title, description, sections } = req.body;
    const result = await this.svc.createSystemQuestionnaire({ caseTypeId, stage, title, description, sections });

    await auditPlatform(
      "platform.questionnaire_created",
      result.id,
      `"${title}" published for every firm`,
      { caseTypeId, stage: stage ?? "intake" },
    );

    sendSuccess(res, result, "System questionnaire created successfully", 201);
  });

  addSystemSection = asyncWrap(async (req: Request, res: Response) => {
    const { title, description, orderIndex } = req.body;
    const result = await this.svc.addSystemSection(req.params.id as string, { title, description, orderIndex });

    await auditPlatform(
      "platform.questionnaire_section_created",
      result.id,
      `"${title}" added to the questionnaire for every firm`,
      { questionnaireId: req.params.id },
    );

    sendSuccess(res, result, "Section added successfully", 201);
  });

  addSystemQuestion = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.addSystemQuestion(
      req.params.id as string,
      req.params.sectionId as string,
      req.body,
    );
    await auditPlatform(
      "platform.questionnaire_question_created",
      result.id,
      `"${result.label}" asked of every firm's clients`,
      { questionnaireId: req.params.id, sectionId: req.params.sectionId },
    );

    sendSuccess(res, result, "Question added successfully", 201);
  });

  updateSystemQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.updateSystemQuestionnaire(
      req.params.id as string,
      req.body,
    );

    await auditPlatform(
      "platform.questionnaire_updated",
      result.id,
      `Questionnaire reworded to "${result.title}"`,
    );

    sendSuccess(res, result, "Questionnaire updated successfully");
  });

  updateSystemSection = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.updateSystemSection(
      req.params.sectionId as string,
      req.body,
    );

    await auditPlatform(
      "platform.questionnaire_section_updated",
      result.id,
      `Section reworded to "${result.title}"`,
      { questionnaireId: req.params.id },
    );

    sendSuccess(res, result, "Section updated successfully");
  });

  deleteSystemSection = asyncWrap(async (req: Request, res: Response) => {
    const sectionId = req.params.sectionId as string;
    const deleted = await this.svc.deleteSystemSection(sectionId);

    await auditPlatform(
      "platform.questionnaire_section_deleted",
      sectionId,
      `"${deleted.title}" removed from every firm's questionnaire, with its questions and their answers`,
      { questionnaireId: req.params.id },
    );

    sendSuccess(res, null, "Section removed for every firm");
  });

  updateSystemQuestion = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.updateSystemQuestion(
      req.params.questionId as string,
      req.body,
    );

    await auditPlatform(
      "platform.questionnaire_question_updated",
      result.id,
      `Question reworded to "${result.label}"`,
      { questionnaireId: req.params.id, sectionId: req.params.sectionId },
    );

    sendSuccess(res, result, "Question updated successfully");
  });

  deleteSystemQuestion = asyncWrap(async (req: Request, res: Response) => {
    const questionId = req.params.questionId as string;
    const deleted = await this.svc.deleteSystemQuestion(questionId);

    await auditPlatform(
      "platform.questionnaire_question_deleted",
      questionId,
      `"${deleted.label}" no longer asked, and its answers removed`,
      { questionnaireId: req.params.id, sectionId: req.params.sectionId },
    );

    sendSuccess(res, null, "Question removed for every firm");
  });

  // Firm and per-matter additions
  //
  // One set of handlers serves both tiers. The scope comes from the route —
  // `/case-types/:caseTypeId/...` writes firm-wide content, `/cases/:caseId/...`
  // writes content for that matter alone — so no request can nominate its own
  // reach, and neither can name `system`.

  getMergedQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getMergedQuestionnaire(
      organizationId!,
      req.params.caseTypeId as string,
      { stage: req.query.stage as QuestionnaireStage | undefined },
    );
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  /**
   * The case questionnaire as the matter's own team sees it: the platform's
   * backbone, the firm's standing additions, and this matter's custom sections.
   */
  getCaseQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getCaseQuestionnaire(
      organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Case questionnaire retrieved successfully");
  });


  getIntakeResponseForCase = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getIntakeResponseForCase(
      organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Intake response retrieved successfully");
  });
  getCaseResponse = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getCaseResponse(
      organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Case response retrieved successfully");
  });

  saveCaseAnswers = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const result = await this.svc.saveCaseAnswers(
      organizationId!,
      req.params.caseId as string,
      staffId ?? undefined,
      req.body,
    );
    sendSuccess(res, result, "Answers saved successfully");
  });

  sendCaseQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const result = await this.svc.sendCaseQuestionnaire(
      organizationId!,
      req.params.caseId as string,
      staffId ?? undefined,
      req.body,
    );
    sendSuccess(res, result, "Questionnaire sent to the client");
  });

  // ── Answer history ─────────────────────────────────────────────────────────

  getCaseVersions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getCaseVersions(
      organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Saves retrieved successfully");
  });

  getCaseVersion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getCaseVersion(
      organizationId!,
      req.params.versionId as string,
    );
    sendSuccess(res, result, "Save retrieved successfully");
  });

  getAnswerHistory = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getAnswerHistory(
      organizationId!,
      req.params.caseId as string,
      req.params.questionId as string,
    );
    sendSuccess(res, result, "Answer history retrieved successfully");
  });

  restoreAnswer = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const result = await this.svc.restoreAnswer(
      organizationId!,
      req.params.caseId as string,
      req.params.revisionId as string,
      staffId ?? undefined,
    );
    sendSuccess(res, result, "Answer restored successfully");
  });

  restoreVersion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const result = await this.svc.restoreVersion(
      organizationId!,
      req.params.caseId as string,
      req.params.versionId as string,
      staffId ?? undefined,
    );
    sendSuccess(res, result, "Questionnaire restored successfully");
  });

  addSection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { title, description, orderIndex, stage } = req.body;
    const result = await this.svc.addSection({
      organizationId: organizationId!,
      ...(await this.scopeFromRoute(req)),
      stage,
      title,
      description,
      orderIndex,
    });
    sendSuccess(res, result, "Section added successfully", 201);
  });

  updateSection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.updateSection(
      organizationId!,
      req.params.sectionId as string,
      req.body,
    );
    sendSuccess(res, result, "Section updated successfully");
  });

  deleteSection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    await this.svc.deleteSection(
      organizationId!,
      req.params.sectionId as string,
    );
    sendSuccess(res, null, "Section deleted successfully");
  });

  addQuestion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.addQuestion({
      organizationId: organizationId!,
      ...(await this.scopeFromRoute(req)),
      ...req.body,
    });
    sendSuccess(res, result, "Question added successfully", 201);
  });

  updateQuestion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.updateQuestion(
      organizationId!,
      req.params.questionId as string,
      req.body,
    );
    sendSuccess(res, result, "Question updated successfully");
  });

  deleteQuestion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    await this.svc.deleteQuestion(
      organizationId!,
      req.params.questionId as string,
    );
    sendSuccess(res, null, "Question deleted successfully");
  });

  /**
   * Read the write's reach off the URL, never off the body.
   *
   * A `:caseId` route resolves the matter's own case type, so a per-matter
   * question cannot be filed against a case type the matter does not belong to
   * — which is the one way a caller could otherwise have reached across.
   */
  private scopeFromRoute = async (
    req: Request,
  ): Promise<{ scope: "firm" | "case"; caseTypeId: string; caseId?: string }> => {
    const caseId = req.params.caseId as string | undefined;
    if (!caseId) {
      return { scope: "firm", caseTypeId: req.params.caseTypeId as string };
    }
    const { organizationId } = getRequestContext();
    const caseTypeId = await this.svc.getCaseTypeIdForCase(
      organizationId!,
      caseId,
    );
    return { scope: "case", caseTypeId, caseId };
  };

  // Responses

  getResponses = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { caseTypeId, page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });
    const result = await this.svc.getResponses(
      organizationId!,
      req.params.id as string,
      { caseTypeId: caseTypeId as string, ...queryPagination },
    );
    const { data, pagination } = result;
    sendSuccess(res, data, "Responses retrieved successfully", 200, { pagination });
  });

  getEligibleQuestionnairesForCase = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getEligibleQuestionnairesForCase(
      organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Eligible questionnaires retrieved successfully");
  });

  // Intake: eligible leads, question bank, response review

  getEligibleLeads = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getEligibleLeadsForQuestionnaire(
      organizationId!,
    );
    sendSuccess(res, result, "Eligible leads retrieved successfully");
  });

  getQuestionBank = asyncWrap(async (_req: Request, res: Response) => {
    const result = await this.svc.getQuestionBank();
    sendSuccess(res, result, "Question bank retrieved successfully");
  });

  getCaseTypePreview = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getMergedQuestionnaire(
      organizationId!,
      req.params.caseTypeId as string,
    );
    sendSuccess(res, result, "Case type preview retrieved successfully");
  });

  getResponseDetail = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getResponseDetailById(
      organizationId!,
      req.params.responseId as string,
    );
    sendSuccess(res, result, "Response detail retrieved successfully");
  });

  acceptResponse = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.acceptResponseAndAdvance(
      organizationId!,
      req.params.responseId as string,
    );
    sendSuccess(res, result, "Response accepted successfully");
  });

  sendReminder = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.sendManualReminder(
      organizationId!,
      req.params.sendId as string,
    );
    sendSuccess(res, result, "Reminder sent successfully");
  });

  requestMissingDocuments = asyncWrap(
    async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
      const result = await this.svc.requestMissingDocuments(
        organizationId!,
        req.params.sendId as string,
      );
      sendSuccess(res, result, "Missing documents requested successfully");
    },
  );

  downloadResponsePdf = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { buffer, filename } = await this.svc.generateResponsePdf(
      organizationId!,
      req.params.responseId as string,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.status(200).send(buffer);
  });

  downloadResponseFile = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { buffer, mimeType, filename } =
      await this.svc.getResponseFileForDownload(
        organizationId!,
        req.params.fileId as string,
      );
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.status(200).send(buffer);
  });

  // Token-Based Client Endpoints

  getClientQuestionnaire = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.getClientQuestionnaireByToken(req.params.token as string);
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  saveDraftResponse = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.saveDraftResponseByToken(req.params.token as string, req.body);
    sendSuccess(res, result, "Draft saved successfully");
  });

  submitResponse = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.svc.submitResponseByToken(req.params.token as string, req.body);
    sendSuccess(res, result, "Response submitted successfully");
  });

  uploadResponseFile = asyncWrap(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) throw new BadRequestError("File is required");

    const { responseId, questionId } = req.body;

    const result = await this.svc.uploadResponseFileByToken(req.params.token as string, {
      responseId,
      questionId,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalFilename: file.originalname,
    });

    sendSuccess(res, result, "File uploaded successfully", 201);
  });

  uploadResponseFileForStaff = asyncWrap(
    async (req: Request, res: Response) => {
      const { organizationId } = getRequestContext();
      const file = req.file;
      if (!file) throw new BadRequestError("File is required");

      const { questionId } = req.body;

      const result = await this.svc.uploadResponseFileByStaff(
        organizationId!,
        {
          responseId: req.params.responseId as string,
          questionId,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          fileSize: file.size,
          originalFilename: file.originalname,
        },
      );

      sendSuccess(res, result, "File uploaded successfully", 201);
    },
  );

  // Lead Document Files

  getFilesByLeadId = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const files = await this.svc.getFilesByLeadId(
      req.params.leadId as string,
      organizationId!,
    );
    sendSuccess(res, files, "Lead files retrieved successfully");
  });
}
