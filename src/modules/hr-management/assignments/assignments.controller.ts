import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
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
    async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
      const { filingType } = req.query;

      const result = await this.assignmentsService.getAvailableContractors(
        filingType as FilingType,
        organizationId!,
      );
      sendSuccess(res, result, "Available contractors retrieved successfully");
    },
  );

  assignCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.assignmentsService.assignCase({
      ...req.body,
      organizationId: organizationId!,
    });
    sendSuccess(res, result, "Case assigned successfully", 201);
  });

  getAllAssignments = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.assignmentsService.getAllAssignments(organizationId!);
    sendSuccess(res, result, "Assignments retrieved successfully");
  });

  getAssignmentById = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.assignmentsService.getAssignmentById(
      req.params.id as string,
      organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Assignment not found");
    }
    sendSuccess(res, result, "Assignment retrieved successfully");
  });

  updateAssignmentStatus = asyncWrap(
    async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
      const { status } = req.body;

      const result = await this.assignmentsService.updateAssignmentStatus(
        req.params.id as string,
        organizationId!,
        status,
      );
      if (!result) {
        throw new NotFoundError("Assignment not found");
      }
      sendSuccess(res, result, "Assignment status updated successfully");
    },
  );
}
