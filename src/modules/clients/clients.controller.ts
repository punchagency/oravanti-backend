import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import {
  parseBooleanQuery,
  parsePaginationQuery,
} from "../../utils/pagination";
import { ClientsService } from "./clients.service";

export class ClientsController {
  private svc: ClientsService;

  constructor(clientsService: ClientsService) {
    this.svc = clientsService;
  }

  getCertifications = asyncWrap(async (_req: AuthRequest, res: Response) => {
    res.status(200).json(await this.svc.getCertifications());
  });

  getTeamStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await this.svc.getTeamStaff(req.params.teamId as string, req.organizationId!),
    );
  });

  // ─── Clients ────────────────────────────────────────────────────────────────

  getAllClients = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    res.status(200).json(
      await this.svc.getAllClients(req.organizationId!, {
        search: search as string | undefined,
        all: bypassPagination,
        ...(!bypassPagination ? parsePaginationQuery({ page, limit }) : {}),
      }),
    );
  });

  getClientById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientById(req.params.id as string, req.organizationId!);
    if (!result) throw new NotFoundError("Client not found");
    res.status(200).json(result);
  });

  updateClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateClient(req.params.id as string, req.organizationId!, req.body);
    if (!result) throw new NotFoundError("Client not found");
    res.status(200).json(result);
  });

  deleteClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteClient(req.params.id as string, req.organizationId!);
    res.status(200).json({ message: "Client deleted" });
  });

  // ─── Contacts ───────────────────────────────────────────────────────────────

  getClientContacts = asyncWrap(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await this.svc.getClientContacts(req.params.id as string, req.organizationId!),
    );
  });

  addClientContact = asyncWrap(async (req: AuthRequest, res: Response) => {
    res.status(201).json(
      await this.svc.addClientContact(req.params.id as string, req.organizationId!, req.body),
    );
  });

  updateClientContact = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateClientContact(
      req.params.contactId as string,
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    if (!result) throw new NotFoundError("Contact not found");
    res.status(200).json(result);
  });

  deleteClientContact = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteClientContact(req.params.contactId as string, req.params.id as string, req.organizationId!);
    res.status(200).json({ message: "Contact removed" });
  });

  // ─── Company ────────────────────────────────────────────────────────────────

  getClientCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientCompany(req.params.id as string, req.organizationId!);
    if (!result) throw new NotFoundError("No company linked to this client");
    res.status(200).json(result);
  });

  upsertClientCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await this.svc.upsertClientCompany(req.params.id as string, req.organizationId!, req.body),
    );
  });

  // ─── Cases ──────────────────────────────────────────────────────────────────

  getClientCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    res.status(200).json(
      await this.svc.getClientCases(req.params.id as string, req.organizationId!, {
        all: bypassPagination,
        ...(!bypassPagination ? parsePaginationQuery({ page, limit }) : {}),
      }),
    );
  });
}
