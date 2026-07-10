import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
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
    sendSuccess(res, await this.svc.getCertifications(), "Certifications retrieved successfully");
  });

  getTeamStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
    sendSuccess(res,
      await this.svc.getTeamStaff(req.params.teamId as string, req.organizationId!),
      "Team staff retrieved successfully",
    );
  });

  // ─── Clients ────────────────────────────────────────────────────────────────

  getAllClients = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { search, page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    const result = await this.svc.getAllClients(req.organizationId!, {
      search: search as string | undefined,
      all: bypassPagination,
      ...(!bypassPagination ? parsePaginationQuery({ page, limit }) : {}),
    });
    if (bypassPagination) {
      sendSuccess(res, result, "Clients retrieved successfully");
    } else {
      const r = result as { data: unknown; pagination: unknown };
      sendSuccess(res, r.data, "Clients retrieved successfully", 200, { pagination: r.pagination });
    }
  });

  getClientById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientById(req.params.id as string, req.organizationId!);
    if (!result) throw new NotFoundError("Client not found");
    sendSuccess(res, result, "Client retrieved successfully");
  });

  updateClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.updateClient(req.params.id as string, req.organizationId!, req.body);
    if (!result) throw new NotFoundError("Client not found");
    sendSuccess(res, result, "Client updated successfully");
  });

  deleteClient = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteClient(req.params.id as string, req.organizationId!);
    sendSuccess(res, null, "Client deleted successfully");
  });

  // ─── Contacts ───────────────────────────────────────────────────────────────

  getClientContacts = asyncWrap(async (req: AuthRequest, res: Response) => {
    sendSuccess(res,
      await this.svc.getClientContacts(req.params.id as string, req.organizationId!),
      "Client contacts retrieved successfully",
    );
  });

  addClientContact = asyncWrap(async (req: AuthRequest, res: Response) => {
    sendSuccess(res,
      await this.svc.addClientContact(req.params.id as string, req.organizationId!, req.body),
      "Client contact added successfully",
      201,
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
    sendSuccess(res, result, "Client contact updated successfully");
  });

  deleteClientContact = asyncWrap(async (req: AuthRequest, res: Response) => {
    await this.svc.deleteClientContact(req.params.contactId as string, req.params.id as string, req.organizationId!);
    sendSuccess(res, null, "Client contact removed successfully");
  });

  // ─── Company ────────────────────────────────────────────────────────────────

  getClientCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getClientCompany(req.params.id as string, req.organizationId!);
    if (!result) throw new NotFoundError("No company linked to this client");
    sendSuccess(res, result, "Client company retrieved successfully");
  });

  upsertClientCompany = asyncWrap(async (req: AuthRequest, res: Response) => {
    sendSuccess(res,
      await this.svc.upsertClientCompany(req.params.id as string, req.organizationId!, req.body),
      "Client company saved successfully",
    );
  });

  // ─── Cases ──────────────────────────────────────────────────────────────────

  getClientCases = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    const result = await this.svc.getClientCases(req.params.id as string, req.organizationId!, {
      all: bypassPagination,
      ...(!bypassPagination ? parsePaginationQuery({ page, limit }) : {}),
    });
    if (bypassPagination) {
      sendSuccess(res, result, "Client cases retrieved successfully");
    } else {
      const r = result as { data: unknown; pagination: unknown };
      sendSuccess(res, r.data, "Client cases retrieved successfully", 200, { pagination: r.pagination });
    }
  });
}
