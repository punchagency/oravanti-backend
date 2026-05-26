import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { AddStaffBody, UpdateStaffBody } from "../../../types/hr.types";
import * as staffService from "./staffs.service";

export const getAll = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.getAllStaff(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.getStaffById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Staff member not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const addStaff = async (req: AuthRequest, res: Response) => {
  const { firstName, lastName, email, phone, role, teamId, startDate } =
    req.body as AddStaffBody;

  if (
    !firstName ||
    !lastName ||
    !email ||
    !phone ||
    !role ||
    !teamId ||
    !startDate
  ) {
    throw new BadRequestError("All fields are required");
  }

  try {
    const result = await staffService.addStaff({
      ...req.body,
      firmId: req.firmId!,
    });
    res.status(201).json({ message: "Staff member added", staff: result });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateStaff = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.updateStaff(
      req.params.id as string,
      req.firmId!,
      req.body as UpdateStaffBody,
    );
    if (!result) {
      throw new NotFoundError("Staff member not found");
    }
    res.status(200).json({ message: "Staff member updated", staff: result });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const deleteStaff = async (req: AuthRequest, res: Response) => {
  try {
    const result = await staffService.deleteStaff(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Staff member not found");
    }
    res.status(200).json({ message: "Staff member deleted" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
