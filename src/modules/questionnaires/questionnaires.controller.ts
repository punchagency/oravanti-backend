import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import { QuestionnairesService } from "./questionnaires.service";

export class QuestionnairesController {
  private svc: QuestionnairesService;

  constructor(questionnairesService: QuestionnairesService) {
    this.svc = questionnairesService;
  }

  // ── System Questionnaire Read ──────────────────────────────────────────────

  getSystemQuestionnaires = asyncWrap(async (_req: AuthRequest, res: Response) => {
    const result = await this.svc.getSystemQuestionnaires();
    sendSuccess(res, result, "System questionnaires retrieved successfully");
  });

  getSystemQuestionnaireByCaseType = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireByCaseType(req.params.caseTypeId as string);
    if (!result) throw new NotFoundError("Questionnaire not found for this case type");
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  getSystemQuestionnaireById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireById(req.params.id as string);
    if (!result) throw new NotFoundError("Questionnaire not found");
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  // ── System Questionnaire Management (admin only) ─────────────────────────

  createSystemQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseTypeId, title, description, sections } = req.body;
    const result = await this.svc.createSystemQuestionnaire({ caseTypeId, title, description, sections });
    sendSuccess(res, result, "System questionnaire created successfully", 201);
  });

  addSystemSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, orderIndex } = req.body;
    const result = await this.svc.addSystemSection(req.params.id as string, { title, description, orderIndex });
    sendSuccess(res, result, "Section added successfully", 201);
  });

  addSystemQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.addSystemQuestion(
      req.params.id as string,
      req.params.sectionId as string,
      req.body,
    );
    sendSuccess(res, result, "Question added successfully", 201);
  });

  // ── Firm Questionnaire Additions ────────────────────────────────────────────

  getMergedQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getMergedQuestionnaire(
      req.organizationId!,
      req.params.caseTypeId as string,
    );
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  addFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, orderIndex } = req.body;
    const result = await this.svc.addFirmSection(
      req.organizationId!,
      req.params.caseTypeId as string,
      { title, description, orderIndex },
    );
    sendSuccess(res, result, "Firm section added successfully", 201);
  });

  updateFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateFirmSection(
      req.organizationId!,
      req.params.sectionId as string,
      req.body,
    );
    sendSuccess(res, result, "Firm section updated successfully");
  });

  deleteFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteFirmSection(req.organizationId!, req.params.sectionId as string);
    sendSuccess(res, null, "Section deleted successfully");
  });

  addFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.addFirmQuestion(
      req.organizationId!,
      req.params.caseTypeId as string,
      req.body,
    );
    sendSuccess(res, result, "Question added successfully", 201);
  });

  updateFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateFirmQuestion(
      req.organizationId!,
      req.params.questionId as string,
      req.body,
    );
    sendSuccess(res, result, "Question updated successfully");
  });

  deleteFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteFirmQuestion(req.organizationId!, req.params.questionId as string);
    sendSuccess(res, null, "Question deleted successfully");
  });

  // ── Responses ─────────────────────────────────────────────────────────────

  getResponses = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseTypeId, page, limit } = req.query;
    const queryPagination = parsePaginationQuery({ page, limit });
    const result = await this.svc.getResponses(
      req.organizationId!,
      req.params.id as string,
      { caseTypeId: caseTypeId as string, ...queryPagination },
    );
    const { data, pagination } = result;
    sendSuccess(res, data, "Responses retrieved successfully", 200, { pagination });
  });

  getEligibleQuestionnairesForCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getEligibleQuestionnairesForCase(
      req.organizationId!,
      req.params.caseId as string,
    );
    sendSuccess(res, result, "Eligible questionnaires retrieved successfully");
  });

  // ── Intake: eligible leads, question bank, response review ──────────────────

  getEligibleLeads = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getEligibleLeadsForQuestionnaire(
      req.organizationId!,
    );
    sendSuccess(res, result, "Eligible leads retrieved successfully");
  });

  getQuestionBank = asyncWrap(async (_req: AuthRequest, res: Response) => {
    const result = await this.svc.getQuestionBank();
    sendSuccess(res, result, "Question bank retrieved successfully");
  });

  getCaseTypePreview = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getMergedQuestionnaire(
      req.organizationId!,
      req.params.caseTypeId as string,
    );
    sendSuccess(res, result, "Case type preview retrieved successfully");
  });

  getResponseDetail = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getResponseDetailById(
      req.organizationId!,
      req.params.responseId as string,
    );
    sendSuccess(res, result, "Response detail retrieved successfully");
  });

  acceptResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.acceptResponseAndAdvance(
      req.organizationId!,
      req.params.responseId as string,
    );
    sendSuccess(res, result, "Response accepted successfully");
  });

  sendReminder = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendManualReminder(
      req.organizationId!,
      req.params.sendId as string,
    );
    sendSuccess(res, result, "Reminder sent successfully");
  });

  requestMissingDocuments = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const result = await this.svc.requestMissingDocuments(
        req.organizationId!,
        req.params.sendId as string,
      );
      sendSuccess(res, result, "Missing documents requested successfully");
    },
  );

  downloadResponsePdf = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { buffer, filename } = await this.svc.generateResponsePdf(
      req.organizationId!,
      req.params.responseId as string,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.status(200).send(buffer);
  });

  downloadResponseFile = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { buffer, mimeType, filename } =
      await this.svc.getResponseFileForDownload(
        req.organizationId!,
        req.params.fileId as string,
      );
    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.status(200).send(buffer);
  });

  // ── Token-Based Client Endpoints ───────────────────────────────────────────

  getClientQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientQuestionnaireByToken(req.params.token as string);
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  });

  saveDraftResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.saveDraftResponseByToken(req.params.token as string, req.body);
    sendSuccess(res, result, "Draft saved successfully");
  });

  submitResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.submitResponseByToken(req.params.token as string, req.body);
    sendSuccess(res, result, "Response submitted successfully");
  });

  uploadResponseFile = asyncWrap(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) throw new BadRequestError("File is required");

    const { responseId, questionId, questionSource } = req.body;

    const result = await this.svc.uploadResponseFileByToken(req.params.token as string, {
      responseId,
      questionId,
      questionSource: questionSource ?? undefined,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      fileSize: file.size,
      originalFilename: file.originalname,
    });

    sendSuccess(res, result, "File uploaded successfully", 201);
  });

  uploadResponseFileForStaff = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const file = req.file;
      if (!file) throw new BadRequestError("File is required");

      const { questionId, questionSource } = req.body;

      const result = await this.svc.uploadResponseFileByStaff(
        req.organizationId!,
        {
          responseId: req.params.responseId as string,
          questionId,
          questionSource: questionSource ?? undefined,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          fileSize: file.size,
          originalFilename: file.originalname,
        },
      );

      sendSuccess(res, result, "File uploaded successfully", 201);
    },
  );
}
