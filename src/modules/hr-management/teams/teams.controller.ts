import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpdateTeamBody } from "../../../types/hr.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
import { TeamsService } from "./teams.service";

export class TeamsController {
  private teamsService: TeamsService;

  constructor(teamsService: TeamsService) {
    this.teamsService = teamsService;
  }

  getAll = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.getAllTeams(req.organizationId!);
    res.status(200).json(result);
  });

  getById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.getTeamById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json(result);
  });

  createTeam = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.createTeam({
      ...req.body,
      organizationId: req.organizationId!,
    });
    res.status(201).json({ message: "Team created", team: result });
  });

  updateTeam = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.updateTeam(
      req.params.id as string,
      req.organizationId!,
      req.body as UpdateTeamBody,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json({ message: "Team updated", team: result });
  });

  deleteTeam = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.deleteTeam(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json({ message: "Team deleted" });
  });

  getEligibleLeads = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.teamsService.getEligibleLeads(req.organizationId!);
    res.status(200).json(result);
  });
}
