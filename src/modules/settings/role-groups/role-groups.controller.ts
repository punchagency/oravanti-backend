import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { RoleGroupsService } from "./role-groups.service";

export class RoleGroupsController {
  constructor(private readonly service: RoleGroupsService) {}

  listGroups = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { q, page, limit } = req.query as Record<string, string | undefined>;
    const result = await this.service.listGroups(organizationId!, {
      q,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    sendSuccess(res, result, "Role groups retrieved successfully");
  });

  listMemberships = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.listMemberships(organizationId!);
    sendSuccess(res, result, "Role group memberships retrieved successfully");
  });

  getGroup = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.getGroupById(
      organizationId!,
      req.params.groupId as string,
    );
    sendSuccess(res, result, "Role group retrieved successfully");
  });

  createGroup = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { name, description, roles } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await this.service.createGroup(organizationId!, {
      name,
      description,
      roles: Array.isArray(roles) ? roles : [],
    });
    sendSuccess(res, result, "Role group created successfully");
  });

  updateGroup = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { name, description, roles } = req.body;
    const result = await this.service.updateGroup(
      organizationId!,
      req.params.groupId as string,
      {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(roles !== undefined && { roles: Array.isArray(roles) ? roles : [] }),
      },
    );
    sendSuccess(res, result, "Role group updated successfully");
  });

  deleteGroup = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.deleteGroup(
      organizationId!,
      req.params.groupId as string,
    );
    sendSuccess(res, result, "Role group deleted successfully");
  });

  addMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { memberId } = req.body;
    if (!memberId || typeof memberId !== "string") {
      return res.status(400).json({ error: "memberId is required" });
    }
    const result = await this.service.addMember(
      organizationId!,
      req.params.groupId as string,
      memberId,
    );
    sendSuccess(res, result, "Member added to group successfully");
  });

  removeMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.removeMember(
      organizationId!,
      req.params.groupId as string,
      req.params.memberId as string,
    );
    sendSuccess(res, result, "Member removed from group successfully");
  });
}
