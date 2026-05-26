import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { CreateTeamBody, UpdateTeamBody } from "../../../types/hr.types";
import * as teamsService from "./teams.service";

export const getAll = async (req: AuthRequest, res: Response) => {
  try {
    const result = await teamsService.getAllTeams(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await teamsService.getTeamById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const createTeam = async (req: AuthRequest, res: Response) => {
  const { name } = req.body as CreateTeamBody;

  if (!name) {
    throw new BadRequestError("Team name is required");
  }

  try {
    const result = await teamsService.createTeam({
      ...req.body,
      firmId: req.firmId!,
    });
    res.status(201).json({ message: "Team created", team: result });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const updateTeam = async (req: AuthRequest, res: Response) => {
  try {
    const result = await teamsService.updateTeam(
      req.params.id as string,
      req.firmId!,
      req.body as UpdateTeamBody,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json({ message: "Team updated", team: result });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const deleteTeam = async (req: AuthRequest, res: Response) => {
  try {
    const result = await teamsService.deleteTeam(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Team not found");
    }
    res.status(200).json({ message: "Team deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getEligibleLeads = async (req: AuthRequest, res: Response) => {
  try {
    const result = await teamsService.getEligibleLeads(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
