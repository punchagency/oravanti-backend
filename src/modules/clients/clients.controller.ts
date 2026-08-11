import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
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

  getCertifications = asyncWrap(async (_req: Request, res: Response) => {
    sendSuccess(res, await this.svc.getCertifications(), "Certifications retrieved successfully");
  });

  getTeamStaff = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    sendSuccess(res,
      await this.svc.getTeamStaff(req.params.teamId as string, organizationId!),
      "Team staff retrieved successfully",
    );
  });

  // Clients

  getAllClients = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const { search, page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    const result = await this.svc.getAllClients(organizationId!, {
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

  getClientById = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.getClientById(req.params.id as string, organizationId!);
    if (!result) throw new NotFoundError("Client not found");
    sendSuccess(res, result, "Client retrieved successfully");
  });

  updateClient = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.updateClient(req.params.id as string, organizationId!, req.body);
    if (!result) throw new NotFoundError("Client not found");
    sendSuccess(res, result, "Client updated successfully");
  });

  deleteClient = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    await this.svc.deleteClient(req.params.id as string, organizationId!);
    sendSuccess(res, null, "Client deleted successfully");
  });

  // Contacts

  getClientContacts = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    sendSuccess(res,
      await this.svc.getClientContacts(req.params.id as string, organizationId!),
      "Client contacts retrieved successfully",
    );
  });

  addClientContact = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    sendSuccess(res,
      await this.svc.addClientContact(req.params.id as string, organizationId!, req.body),
      "Client contact added successfully",
      201,
    );
  });

  updateClientContact = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.updateClientContact(
      req.params.contactId as string,
      req.params.id as string,
      organizationId!,
      req.body,
    );
    if (!result) throw new NotFoundError("Contact not found");
    sendSuccess(res, result, "Client contact updated successfully");
  });

  deleteClientContact = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    await this.svc.deleteClientContact(req.params.contactId as string, req.params.id as string, organizationId!);
    sendSuccess(res, null, "Client contact removed successfully");
  });

  // Company

  getClientCompany = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.getClientCompany(req.params.id as string, organizationId!);
    if (!result) throw new NotFoundError("No company linked to this client");
    sendSuccess(res, result, "Client company retrieved successfully");
  });

  upsertClientCompany = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    sendSuccess(res,
      await this.svc.upsertClientCompany(req.params.id as string, organizationId!, req.body),
      "Client company saved successfully",
    );
  });

  // Cases

  getClientCases = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const { page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");
    const result = await this.svc.getClientCases(req.params.id as string, organizationId!, {
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

  // ─── Client Profile (self-service) ────────────────────────────────────────

  getClientProfile = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) throw new NotFoundError("Unauthorized");
    const result = await this.svc.getClientProfile(userId);
    if (!result) throw new NotFoundError("Client profile not found");
    sendSuccess(res, result, "Profile retrieved successfully");
  });

  updateClientProfile = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) throw new NotFoundError("Unauthorized");
    const result = await this.svc.updateClientProfile(userId, req.body);
    if (!result) throw new NotFoundError("Client profile not found");
    sendSuccess(res, result, "Profile updated successfully");
  });

  uploadClientAvatar = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) throw new NotFoundError("Unauthorized");

    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const result = await this.svc.uploadClientAvatar(userId, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    if (!result) throw new NotFoundError("Client profile not found");
    sendSuccess(res, {}, "Avatar uploaded successfully");
  });

  // ─── Portal Methods (lead-converted clients) ──────────────────────────────

  listConvertedClients = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { search, practiceAreaId, portalStatus, page, limit, all } = req.query;
    const bypassPagination = parseBooleanQuery(all, "all");

    const result = await this.svc.listConvertedClients(organizationId!, {
      search: search as string | undefined,
      practiceAreaId: practiceAreaId as string | undefined,
      portalStatus: portalStatus as string | undefined,
      all: bypassPagination,
      ...(!bypassPagination ? parsePaginationQuery({ page, limit }) : {}),
    });

    if (bypassPagination) {
      sendSuccess(res, result, "Clients retrieved successfully");
    } else {
      const r = result as { data: unknown; pagination: unknown };
      sendSuccess(res, r.data, "Clients retrieved successfully", 200, {
        pagination: r.pagination,
      });
    }
  });

  getConvertedClientDetail = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getConvertedClientDetail(
      req.params.clientId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Client retrieved successfully");
  });

  sendPortalInvitation = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.sendPortalInvitation(
      req.params.clientId as string,
      organizationId!,
      req.headers as Record<string, string>,
    );
    sendSuccess(res, result, "Portal invitation sent successfully");
  });

  resetClientPassword = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.resetClientPassword(
      req.params.clientId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Password reset email sent successfully");
  });

  getClientSessions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getClientSessions(
      req.params.clientId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Portal sessions retrieved successfully");
  });

  revokeClientSession = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.revokeClientSession(
      req.params.clientId as string,
      req.params.token as string,
      organizationId!,
    );
    sendSuccess(res, result, "Session revoked successfully");
  });

  getPortalStatus = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getPortalStatus(
      req.params.clientId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Portal status retrieved successfully");
  });
}
