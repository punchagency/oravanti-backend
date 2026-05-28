import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { AddStaffBody, UpdateStaffBody } from "../../../types/hr.types";
import { StaffService } from "./staffs.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../../utils/error/app-error";

export class StaffController {
  private staffService: StaffService;

  constructor(staffService: StaffService) {
    this.staffService = staffService;
  }

  getAll = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.staffService.getAllStaff(req.firmId!);
      res.status(200).json(result);
    
  });

  getById = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.staffService.getStaffById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        throw new NotFoundError("Staff member not found");
      }
      res.status(200).json(result);
    
  });

  addStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
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

    
      const result = await this.staffService.addStaff({
        ...req.body,
        firmId: req.firmId!,
      });
      res.status(201).json({ message: "Staff member added", staff: result });
    
  });

  updateStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.staffService.updateStaff(
        req.params.id as string,
        req.firmId!,
        req.body as UpdateStaffBody,
      );
      if (!result) {
        throw new NotFoundError("Staff member not found");
      }
      res.status(200).json({ message: "Staff member updated", staff: result });
    
  });

  deleteStaff = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.staffService.deleteStaff(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        throw new NotFoundError("Staff member not found");
      }
      res.status(200).json({ message: "Staff member deleted" });
    
  });
}
