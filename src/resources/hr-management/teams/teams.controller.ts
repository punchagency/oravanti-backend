import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { CreateTeamBody, UpdateTeamBody } from "../../../types/hr.types";
import { TeamsService } from "./teams.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../../utils/error/app-error";

export class TeamsController {
  private teamsService: TeamsService;

  constructor(teamsService: TeamsService) {
    this.teamsService = teamsService;
  }

  getAll = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.teamsService.getAllTeams(req.firmId!);
      res.status(200).json(result);
    
  });

  getById = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.teamsService.getTeamById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        throw new NotFoundError("Team not found");
      }
      res.status(200).json(result);
    
  });

  createTeam = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { name } = req.body as CreateTeamBody;

    if (!name) {
      throw new BadRequestError("Team name is required");
    }

    
      const result = await this.teamsService.createTeam({
        ...req.body,
        firmId: req.firmId!,
      });
      res.status(201).json({ message: "Team created", team: result });
    
  });

  updateTeam = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.teamsService.updateTeam(
        req.params.id as string,
        req.firmId!,
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
        req.firmId!,
      );
      if (!result) {
        throw new NotFoundError("Team not found");
      }
      res.status(200).json({ message: "Team deleted" });
    
  });

  getEligibleLeads = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.teamsService.getEligibleLeads(req.firmId!);
      res.status(200).json(result);
    
  });
}
