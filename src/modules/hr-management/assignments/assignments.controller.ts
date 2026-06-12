import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { FilingType } from "../../../types/hr.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
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
      res.status(200).json(result);
    },
  );

  assignCase = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.assignCase({
      ...req.body,
      organizationId: req.organizationId!,
    });
    res
      .status(201)
      .json({ message: "Case assigned successfully", assignment: result });
  });

  getAllAssignments = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.getAllAssignments(req.organizationId!);
    res.status(200).json(result);
  });

  getAssignmentById = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.assignmentsService.getAssignmentById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!result) {
      throw new NotFoundError("Assignment not found");
    }
    res.status(200).json(result);
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
      res
        .status(200)
        .json({ message: "Assignment status updated", assignment: result });
    },
  );
}
