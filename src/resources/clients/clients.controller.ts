import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../errors/app-error";
import { sendErrorResponse } from "../../errors";
import { AuthRequest } from "../../middleware/auth.middleware";
import { ClientsService } from "./clients.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError, NotFoundError, ConflictError } from "../../utils/error/app-error";

export class ClientsController {
  private clientsService: ClientsService;

  constructor(clientsService: ClientsService) {
    this.clientsService = clientsService;
  }

  getAllCompanies = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getAllCompanies(req.firmId!);
    res.status(200).json(result);
  });

  getCompanyById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getCompanyById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Company not found");
    }
    res.status(200).json(result);
  });

  createCompanyWithClients = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const {
        company: companyData,
        individuals,
        acknowledgeConflict,
      } = req.body;

      if (
        !companyData ||
        !individuals ||
        !Array.isArray(individuals) ||
        !individuals.length
      ) {
        throw new BadRequestError(
          "company and at least one individual are required",
        );
      }

      const result = await this.clientsService.createCompanyWithClients(
        req.firmId!,
        companyData,
        individuals,
        { adminId: req.adminId, staffId: req.staffId },
        { acknowledgeConflict },
      );
      if ("type" in result && result.type === "conflict_warning") {
        throw new ConflictError(result.type, result);
      }
      res.status(201).json(result);
    },
  );

  updateCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.updateCompany(
      req.params.id as string,
      req.firmId!,
      req.body,
    );

    if (!result) {
      throw new NotFoundError("Company not found");
    }

    res.status(200).json(result);
  });

  deleteCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.clientsService.deleteCompany(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Company deleted" });
  });

  addClientToCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { clientData, caseData } = req.body;

    if (!clientData || !caseData) {
      throw new BadRequestError("clientData and caseData are required");
    }

    const result = await this.clientsService.addClientToCompany(
      req.params.id as string,
      req.firmId!,
      clientData,
      caseData,
      { adminId: req.adminId, staffId: req.staffId },
    );
    res.status(201).json(result);
  });

  getCertifications = asyncWrap(async (_req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getCertifications();
    res.status(200).json(result);
  });

  getAllClients = asyncWrap(async (req: AuthRequest, res: Response) => {
    const search = req.query.search as string | undefined;

    const result = await this.clientsService.getAllClients(req.firmId!, search);
    res.status(200).json(result);
  });

  getClientById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getClientById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    res.status(200).json(result);
  });

  createClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    const {
      client: clientData,
      case: caseData,
      acknowledgeConflict,
    } = req.body;

    if (!clientData || !caseData) {
      throw new BadRequestError("client and case data are required");
    }

    const result = await this.clientsService.createClient(
      req.firmId!,
      clientData,
      caseData,
      { acknowledgeConflict },
    );
    if ("type" in result && result.type === "conflict_warning") {
      throw new ConflictError(result.type, result);
    }
    res.status(201).json(result);
  });

  updateClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.updateClient(
      req.params.id as string,
      req.firmId!,
      req.body,
    );
    if (!result) {
      throw new NotFoundError("Client not found");
    }
    res.status(200).json(result);
  });

  deleteClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.clientsService.deleteClient(
      req.params.id as string,
      req.firmId!,
    );
    res.status(200).json({ message: "Client deleted" });
  });

  getClientCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getClientCases(
      req.params.id as string,
      req.firmId!,
    );

    res.status(200).json(result);
  });

  addCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { acknowledgeExistingCase, ...caseData } = req.body;

    const result = await this.clientsService.addCase(
      req.params.id as string,
      req.firmId!,
      caseData,
      { acknowledgeExistingCase },
    );
    if ("type" in result && result.type === "case_exists_warning") {
      throw new ConflictError(result.type, result);
    }
    res.status(201).json(result);
  });

  updateCaseStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      throw new BadRequestError("status is required");
    }

    const result = await this.clientsService.updateCaseStatus(
      req.params.caseId as string,
      req.firmId!,
      status,
    );
    res.status(200).json(result);
  });

  getTeamStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.clientsService.getTeamStaff(
      req.params.teamId as string,
      req.firmId!,
    );
    res.status(200).json(result);
  });
}
