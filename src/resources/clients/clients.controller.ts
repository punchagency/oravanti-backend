import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { ClientsService } from "./clients.service";

export class ClientsController {
  private clientsService: ClientsService;

  constructor(clientsService: ClientsService) {
    this.clientsService = clientsService;
  }

  getAllCompanies = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getAllCompanies(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getCompanyById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getCompanyById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  createCompanyWithClients = async (req: AuthRequest, res: Response) => {
    const { company: companyData, individuals, acknowledgeConflict } = req.body;

    if (
      !companyData ||
      !individuals ||
      !Array.isArray(individuals) ||
      !individuals.length
    ) {
      res
        .status(400)
        .json({ message: "company and at least one individual are required" });
      return;
    }

    try {
      const result = await this.clientsService.createCompanyWithClients(
        req.firmId!,
        companyData,
        individuals,
        { adminId: req.adminId, staffId: req.staffId },
        { acknowledgeConflict },
      );
      if ("type" in result && result.type === "conflict_warning") {
        res.status(409).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateCompany = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.updateCompany(
        req.params.id as string,
        req.firmId!,
        req.body,
      );
      if (!result) {
        res.status(404).json({ message: "Company not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  deleteCompany = async (req: AuthRequest, res: Response) => {
    try {
      await this.clientsService.deleteCompany(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json({ message: "Company deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  addClientToCompany = async (req: AuthRequest, res: Response) => {
    const { clientData, caseData } = req.body;

    if (!clientData || !caseData) {
      res.status(400).json({ message: "clientData and caseData are required" });
      return;
    }

    try {
      const result = await this.clientsService.addClientToCompany(
        req.params.id as string,
        req.firmId!,
        clientData,
        caseData,
        { adminId: req.adminId, staffId: req.staffId },
      );
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  getCertifications = async (_req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getCertifications();
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getAllClients = async (req: AuthRequest, res: Response) => {
    const search = req.query.search as string | undefined;
    try {
      const result = await this.clientsService.getAllClients(
        req.firmId!,
        search,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getClientById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getClientById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Client not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  createClient = async (req: AuthRequest, res: Response) => {
    const {
      client: clientData,
      case: caseData,
      acknowledgeConflict,
    } = req.body;

    if (!clientData || !caseData) {
      res.status(400).json({ message: "client and case data are required" });
      return;
    }

    try {
      const result = await this.clientsService.createClient(
        req.firmId!,
        clientData,
        caseData,
        { acknowledgeConflict },
      );
      if ("type" in result && result.type === "conflict_warning") {
        res.status(409).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateClient = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.updateClient(
        req.params.id as string,
        req.firmId!,
        req.body,
      );
      if (!result) {
        res.status(404).json({ message: "Client not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  deleteClient = async (req: AuthRequest, res: Response) => {
    try {
      await this.clientsService.deleteClient(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json({ message: "Client deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getClientCases = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getClientCases(
        req.params.id as string,
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  addCase = async (req: AuthRequest, res: Response) => {
    const { acknowledgeExistingCase, ...caseData } = req.body;
    try {
      const result = await this.clientsService.addCase(
        req.params.id as string,
        req.firmId!,
        caseData,
        { acknowledgeExistingCase },
      );
      if ("type" in result && result.type === "case_exists_warning") {
        res.status(409).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateCaseStatus = async (req: AuthRequest, res: Response) => {
    const { status } = req.body;
    if (!status) {
      res.status(400).json({ message: "status is required" });
      return;
    }

    try {
      const result = await this.clientsService.updateCaseStatus(
        req.params.caseId as string,
        req.firmId!,
        status,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  getTeamStaff = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.clientsService.getTeamStaff(
        req.params.teamId as string,
        req.firmId!,
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
