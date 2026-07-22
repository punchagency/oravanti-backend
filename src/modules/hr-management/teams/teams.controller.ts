import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import { UpdateTeamBody } from "../../../types/hr.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
import { sendSuccess } from "../../../utils/send-success";
import { TeamsService } from "./teams.service";

export class TeamsController {
  private teamsService: TeamsService;

  constructor(teamsService: TeamsService) {
    this.teamsService = teamsService;
  }

  getAll = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.getAllTeams(organizationId!);
    sendSuccess(res, result, "Teams retrieved successfully");
  });

  getById = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.getTeamById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    sendSuccess(res, result, "Team retrieved successfully");
  });

  createTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.createTeam({
      ...req.body,
      organizationId: organizationId!,
    });
    sendSuccess(res, result, "Team created successfully", 201);
  });

  updateTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.updateTeam(
      req.params.id as string,
      organizationId!,
      req.body as UpdateTeamBody,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    sendSuccess(res, result, "Team updated successfully");
  });

  deleteTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.deleteTeam(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    sendSuccess(res, null, "Team deleted successfully");
  });

  getEligibleLeads = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.teamsService.getEligibleLeads(organizationId!);
    sendSuccess(res, result, "Eligible leads retrieved successfully");
  });
}
