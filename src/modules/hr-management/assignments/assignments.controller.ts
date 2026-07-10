import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { FilingType } from "../../../types/hr.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
import { sendSuccess } from "../../../utils/send-success";
import { AssignmentsService } from "./assignments.service";

export class AssignmentsController {
  private assignmentsService: AssignmentsService;

  constructor(assignmentsService: AssignmentsService) {
    this.assignmentsService = assignmentsService;
  }

  getAvailableContractors = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { filingType } = req.query;

      const result = await this.assignmentsService.getAvailableContractors(
        filingType as FilingType,
        req.organizationId!,
      );
      sendSuccess(res, result, "Available contractors retrieved successfully");
    },
  );

  assignCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.assignCase({
      ...req.body,
      organizationId: req.organizationId!,
    });
    sendSuccess(res, result, "Case assigned successfully", 201);
  });

  getAllAssignments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.getAllAssignments(req.organizationId!);
    sendSuccess(res, result, "Assignments retrieved successfully");
  });

  getAssignmentById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.getAssignmentById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Assignment not found");
    }
    sendSuccess(res, result, "Assignment retrieved successfully");
  });

  updateAssignmentStatus = asyncWrap(
    async (req: AuthRequest, res: Response) => {
      const { status } = req.body;

      const result = await this.assignmentsService.updateAssignmentStatus(
        req.params.id as string,
        req.organizationId!,
        status,
      );
      if (!result) {
        throw new NotFoundError("Assignment not found");
      }
      sendSuccess(res, result, "Assignment status updated successfully");
    },
  );
}
