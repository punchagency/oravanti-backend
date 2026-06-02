import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { parsePaginationQuery } from "../../utils/pagination";
import { QuestionnairesService } from "./questionnaires.service";

export class QuestionnairesController {
  private questionnairesService: QuestionnairesService;

  constructor(questionnairesService: QuestionnairesService) {
    this.questionnairesService = questionnairesService;
  }

  getAllQuestionnaires = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, status, caseTypeId, page, limit } = req.query;
    const pagination = parsePaginationQuery({ page, limit });

    const result = await this.questionnairesService.getAllQuestionnaires(
      req.organizationId!,
      {
        search: search as string,
        status: status as string,
        caseTypeId: caseTypeId as string,
        ...pagination,
      },
    );

    res.status(200).json(result);
  });

  createQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, firstSectionTitle, caseTypeIds } = req.body;
    if (!title) throw new BadRequestError("title is required");
    if (caseTypeIds && !Array.isArray(caseTypeIds)) {
      throw new BadRequestError("caseTypeIds must be an array");
    }

    const result = await this.questionnairesService.createQuestionnaire(
      req.organizationId!,
      {
        title,
        description,
        firstSectionTitle,
        caseTypeIds,
        createdById: req.staffId,
      },
    );

    res.status(201).json(result);
  });

  getQuestionnaireById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.getQuestionnaireById(
      req.params.id as string,
      req.organizationId!,
    );

    if (!result) throw new NotFoundError("Questionnaire not found");
    res.status(200).json(result);
  });

  updateQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    if (req.body.caseTypeIds && !Array.isArray(req.body.caseTypeIds)) {
      throw new BadRequestError("caseTypeIds must be an array");
    }

    const result = await this.questionnairesService.updateQuestionnaire(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );

    res.status(200).json(result);
  });

  setQuestionnaireCaseTypes = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { caseTypeIds } = req.body;
      if (!Array.isArray(caseTypeIds)) {
        throw new BadRequestError("caseTypeIds must be an array");
      }

      const result = await this.questionnairesService.setQuestionnaireCaseTypes(
        req.params.id as string,
        req.organizationId!,
        caseTypeIds,
      );

      res.status(200).json(result);
    },
  );

  publishQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.publishQuestionnaire(
      req.params.id as string,
      req.organizationId!,
    );

    res.status(200).json(result);
  });

  duplicateQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.duplicateQuestionnaire(
      req.params.id as string,
      req.organizationId!,
      {
        title: req.body.title,
        createdById: req.staffId,
      },
    );

    res.status(201).json(result);
  });

  addSection = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { title, description, orderIndex } = req.body;
    if (!title) throw new BadRequestError("title is required");

    const result = await this.questionnairesService.addSection(
      req.params.id as string,
      req.organizationId!,
      {
        title,
        description,
        orderIndex,
      },
    );

    res.status(201).json(result);
  });

  reorderSections = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { items } = req.body;
    if (!Array.isArray(items)) throw new BadRequestError("items must be an array");

    const result = await this.questionnairesService.reorderSections(
      req.params.id as string,
      req.organizationId!,
      items,
    );

    res.status(200).json(result);
  });

  addQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { sectionId, label, type } = req.body;
    if (!sectionId || !label || !type) {
      throw new BadRequestError("sectionId, label and type are required");
    }

    const result = await this.questionnairesService.addQuestion(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );

    res.status(201).json(result);
  });

  updateQuestion = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.updateQuestion(
      req.params.id as string,
      req.params.questionId as string,
      req.organizationId!,
      req.body,
    );

    res.status(200).json(result);
  });

  reorderQuestions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { items } = req.body;
    if (!Array.isArray(items)) throw new BadRequestError("items must be an array");

    const result = await this.questionnairesService.reorderQuestions(
      req.params.id as string,
      req.organizationId!,
      items,
    );

    res.status(200).json(result);
  });

  addLogicRule = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { condition, actionType, action } = req.body;
    if (!condition || !actionType || !action) {
      throw new BadRequestError("condition, actionType and action are required");
    }

    const result = await this.questionnairesService.addLogicRule(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );

    res.status(201).json(result);
  });

  sendToClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { clientId, caseTypeId, caseId, expiresAt } = req.body;
    if (!clientId || !caseTypeId) {
      throw new BadRequestError("clientId and caseTypeId are required");
    }

    const result = await this.questionnairesService.sendToClient(
      req.params.id as string,
      req.organizationId!,
      {
        clientId,
        caseTypeId,
        caseId,
        sentById: req.staffId,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    );

    res.status(201).json(result);
  });

  getResponses = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { caseTypeId, page, limit } = req.query;
    const pagination = parsePaginationQuery({ page, limit });

    const result = await this.questionnairesService.getResponses(
      req.params.id as string,
      req.organizationId!,
      {
        caseTypeId: caseTypeId as string,
        ...pagination,
      },
    );

    res.status(200).json(result);
  });

  getEligibleQuestionnairesForCase = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { page, limit } = req.query;
      const pagination = parsePaginationQuery({ page, limit });

      const result =
        await this.questionnairesService.getEligibleQuestionnairesForCase(
          req.organizationId!,
          req.params.caseId as string,
          pagination,
        );

      res.status(200).json(result);
    },
  );

  getClientQuestionnaire = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result =
      await this.questionnairesService.getClientQuestionnaireByToken(
        req.params.token as string,
      );

    res.status(200).json(result);
  });

  saveDraftResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.saveDraftResponseByToken(
      req.params.token as string,
      req.body,
    );

    res.status(200).json(result);
  });

  submitResponse = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.questionnairesService.submitResponseByToken(
      req.params.token as string,
      req.body,
    );

    res.status(200).json(result);
  });

  uploadResponseFile = asyncWrap(async (req: AuthRequest, res: Response) => {
    const file = req.file;
    if (!file) throw new BadRequestError("File is required");

    const { responseId, questionId } = req.body;
    if (!responseId || !questionId) {
      throw new BadRequestError("responseId and questionId are required");
    }

    const result =
      await this.questionnairesService.uploadResponseFileByToken(
        req.params.token as string,
        {
          responseId,
          questionId,
          fileBuffer: file.buffer,
          mimeType: file.mimetype,
          fileSize: file.size,
          originalFilename: file.originalname,
        },
      );

    res.status(201).json(result);
  });
}
