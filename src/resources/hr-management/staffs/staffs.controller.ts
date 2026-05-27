import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { AddStaffBody, UpdateStaffBody } from "../../../types/hr.types";
import { StaffService } from "./staffs.service";

export class StaffController {
  private staffService: StaffService;

  constructor(staffService: StaffService) {
    this.staffService = staffService;
  }

  getAll = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.staffService.getAllStaff(req.firmId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  getById = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.staffService.getStaffById(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Staff member not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  addStaff = async (req: AuthRequest, res: Response) => {
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
      res.status(400).json({ message: "All fields are required" });
      return;
    }

    try {
      const result = await this.staffService.addStaff({
        ...req.body,
        firmId: req.firmId!,
      });
      res.status(201).json({ message: "Staff member added", staff: result });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateStaff = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.staffService.updateStaff(
        req.params.id as string,
        req.firmId!,
        req.body as UpdateStaffBody,
      );
      if (!result) {
        res.status(404).json({ message: "Staff member not found" });
        return;
      }
      res.status(200).json({ message: "Staff member updated", staff: result });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  deleteStaff = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.staffService.deleteStaff(
        req.params.id as string,
        req.firmId!,
      );
      if (!result) {
        res.status(404).json({ message: "Staff member not found" });
        return;
      }
      res.status(200).json({ message: "Staff member deleted" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
