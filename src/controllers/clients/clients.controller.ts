import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as clientsService from '../../services/clients/clients.service';

// ─── Companies ────────────────────────────────────────────────────────────────

export const getAllCompanies = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getAllCompanies(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getCompanyById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getCompanyById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Company not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const createCompanyWithClients = async (req: AuthRequest, res: Response) => {
  const { company: companyData, individuals, acknowledgeConflict } = req.body;

  if (!companyData || !individuals || !Array.isArray(individuals) || !individuals.length) {
    res.status(400).json({ message: 'company and at least one individual are required' });
    return;
  }

  try {
    const result = await clientsService.createCompanyWithClients(
      req.firmId!,
      companyData,
      individuals,
      { adminId: req.adminId, staffId: req.staffId },
      { acknowledgeConflict },
    );
    if ('type' in result && result.type === 'conflict_warning') {
      res.status(409).json(result);
      return;
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateCompany = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.updateCompany(req.params.id as string, req.firmId!, req.body);
    if (!result) { res.status(404).json({ message: 'Company not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const deleteCompany = async (req: AuthRequest, res: Response) => {
  try {
    await clientsService.deleteCompany(req.params.id as string, req.firmId!);
    res.status(200).json({ message: 'Company deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const addClientToCompany = async (req: AuthRequest, res: Response) => {
  const { clientData, caseData } = req.body;

  if (!clientData || !caseData) {
    res.status(400).json({ message: 'clientData and caseData are required' });
    return;
  }

  try {
    const result = await clientsService.addClientToCompany(
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

export const getCertifications = async (_req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getCertifications();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getAllClients = async (req: AuthRequest, res: Response) => {
  const search = req.query.search as string | undefined;
  try {
    const result = await clientsService.getAllClients(req.firmId!, search);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getClientById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getClientById(req.params.id as string, req.firmId!);
    if (!result) { res.status(404).json({ message: 'Client not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const createClient = async (req: AuthRequest, res: Response) => {
  const { client: clientData, case: caseData, acknowledgeConflict } = req.body;

  if (!clientData || !caseData) {
    res.status(400).json({ message: 'client and case data are required' });
    return;
  }

  try {
    const result = await clientsService.createClient(req.firmId!, clientData, caseData, { acknowledgeConflict });
    if ('type' in result && result.type === 'conflict_warning') {
      res.status(409).json(result);
      return;
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateClient = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.updateClient(req.params.id as string, req.firmId!, req.body);
    if (!result) { res.status(404).json({ message: 'Client not found' }); return; }
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const deleteClient = async (req: AuthRequest, res: Response) => {
  try {
    await clientsService.deleteClient(req.params.id as string, req.firmId!);
    res.status(200).json({ message: 'Client deleted' });
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getClientCases = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getClientCases(req.params.id as string, req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const addCase = async (req: AuthRequest, res: Response) => {
  const { acknowledgeExistingCase, ...caseData } = req.body;
  try {
    const result = await clientsService.addCase(req.params.id as string, req.firmId!, caseData, { acknowledgeExistingCase });
    if ('type' in result && result.type === 'case_exists_warning') {
      res.status(409).json(result);
      return;
    }
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const updateCaseStatus = async (req: AuthRequest, res: Response) => {
  const { status } = req.body;
  if (!status) { res.status(400).json({ message: 'status is required' }); return; }

  try {
    const result = await clientsService.updateCaseStatus(req.params.caseId as string, req.firmId!, status);
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const getTeamStaff = async (req: AuthRequest, res: Response) => {
  try {
    const result = await clientsService.getTeamStaff(req.params.teamId as string, req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};
