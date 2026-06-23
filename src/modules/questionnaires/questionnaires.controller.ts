import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { QuestionnairesService } from "./questionnaires.service";

export class QuestionnairesController {
  private svc: QuestionnairesService;

  constructor(questionnairesService: QuestionnairesService) {
    this.svc = questionnairesService;
  }

  // ── System Questionnaire Read ──────────────────────────────────────────────

  getSystemQuestionnaires = asyncWrap(async (_req: AuthRequest, res: Response) => {
    res.status(200).json(await this.svc.getSystemQuestionnaires());
  });

  getSystemQuestionnaireByCaseType = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireByCaseType(req.params.caseTypeId as string);
    if (!result) throw new NotFoundError("Questionnaire not found for this case type");
    res.status(200).json(result);
  });

  getSystemQuestionnaireById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getSystemQuestionnaireById(req.params.id as string);
    if (!result) throw new NotFoundError("Questionnaire not found");
    res.status(200).json(result);
  });

  // ── System Questionnaire Management (admin only) ─────────────────────────

  createSystemQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseTypeId, title, description, sections } = req.body;
    const result = await this.svc.createSystemQuestionnaire({ caseTypeId, title, description, sections });
    res.status(201).json(result);
  });

  addSystemSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, orderIndex } = req.body;
    const result = await this.svc.addSystemSection(req.params.id as string, { title, description, orderIndex });
    res.status(201).json(result);
  });

  addSystemQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.addSystemQuestion(
      req.params.id as string,
      req.params.sectionId as string,
      req.body,
    );
    res.status(201).json(result);
  });

  // ── Firm Questionnaire Additions ────────────────────────────────────────────

  getMergedQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getMergedQuestionnaire(
      req.organizationId!,
      req.params.caseTypeId as string,
    );
    res.status(200).json(result);
  });

  addFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, orderIndex } = req.body;
    const result = await this.svc.addFirmSection(
      req.organizationId!,
      req.params.caseTypeId as string,
      { title, description, orderIndex },
    );
    res.status(201).json(result);
  });

  updateFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateFirmSection(
      req.organizationId!,
      req.params.sectionId as string,
      req.body,
    );
    res.status(200).json(result);
  });

  deleteFirmSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteFirmSection(req.organizationId!, req.params.sectionId as string);
    res.status(200).json({ message: "Section deleted" });
  });

  addFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.addFirmQuestion(
      req.organizationId!,
      req.params.caseTypeId as string,
      req.body,
    );
    res.status(201).json(result);
  });

  updateFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateFirmQuestion(
      req.organizationId!,
      req.params.questionId as string,
      req.body,
    );
    res.status(200).json(result);
  });

  deleteFirmQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteFirmQuestion(req.organizationId!, req.params.questionId as string);
    res.status(200).json({ message: "Question deleted" });
  });

  // ── Responses ─────────────────────────────────────────────────────────────

  getResponses = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseTypeId, page, limit } = req.query;
    const pagination = parsePaginationQuery({ page, limit });
    const result = await this.svc.getResponses(
      req.organizationId!,
      req.params.id as string,
      { caseTypeId: caseTypeId as string, ...pagination },
    );
    res.status(200).json(result);
  });

  getEligibleQuestionnairesForCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getEligibleQuestionnairesForCase(
      req.organizationId!,
      req.params.caseId as string,
    );
    res.status(200).json(result);
  });

  // ── Intake: eligible leads, question bank, response review ──────────────────

  getEligibleLeads = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getEligibleLeadsForQuestionnaire(
      req.organizationId!,
    );
    res.status(200).json(result);
  });

  getQuestionBank = asyncWrap(async (_req: AuthRequest, res: Response) => {
    res.status(200).json(await this.svc.getQuestionBank());
  });

  getResponseDetail = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getResponseDetailById(
      req.organizationId!,
      req.params.responseId as string,
    );
    res.status(200).json(result);
  });

  acceptResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.acceptResponseAndAdvance(
      req.organizationId!,
      req.params.responseId as string,
    );
    res.status(200).json(result);
  });

  sendReminder = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendManualReminder(
      req.organizationId!,
      req.params.sendId as string,
    );
    res.status(200).json(result);
  });

  // ── Token-Based Client Endpoints ───────────────────────────────────────────

  getClientQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientQuestionnaireByToken(req.params.token as string);
    res.status(200).json(result);
  });

  saveDraftResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.saveDraftResponseByToken(req.params.token as string, req.body);
    res.status(200).json(result);
  });

  submitResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.submitResponseByToken(req.params.token as string, req.body);
    res.status(200).json(result);
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

    res.status(201).json(result);
  });
}
