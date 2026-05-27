import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { CreateTeamBody, UpdateTeamBody } from "../../../types/hr.types";
import { TeamsService } from "./teams.service";

export class TeamsController {
  private teamsService: TeamsService;

  constructor(teamsService: TeamsService) {
    this.teamsService = teamsService;
  }

  getAll = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.teamsService.getAllTeams(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.teamsService.getTeamById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Team not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  createTeam = async (req: AuthRequest, res: Response) => {
    const { name } = req.body as CreateTeamBody;

    if (!name) {
      res.status(400).json({ message: "Team name is required" });
      return;
    }

    try {
      const result = await this.teamsService.createTeam({
        ...req.body,
        firmId: req.firmId!,
      });
      res.status(201).json({ message: "Team created", team: result });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  updateTeam = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.teamsService.updateTeam(
        req.params.id as string,
        req.firmId!,
        req.body as UpdateTeamBody,
      );
      if (!result) {
        res.status(404).json({ message: "Team not found" });
        return;
      }
      res.status(200).json({ message: "Team updated", team: result });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  deleteTeam = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.teamsService.deleteTeam(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Team not found" });
        return;
      }
      res.status(200).json({ message: "Team deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getEligibleLeads = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.teamsService.getEligibleLeads(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
