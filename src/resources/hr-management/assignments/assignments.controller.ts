import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { AssignCaseBody, FilingType } from "../../../types/hr.types";
import * as assignmentsService from "./assignments.service";

const VALID_FILING_TYPES: FilingType[] = [
  "I-130",
  "I-485",
  "I-765",
  "I-140",
  "N-400",
  "I-131",
];

export const getAvailableContractors = async (
  req: AuthRequest,
  res: Response,
) => {
  const { filingType } = req.query;

  if (!filingType || !VALID_FILING_TYPES.includes(filingType as FilingType)) {
    res
      .status(400)
      .json({ message: "A valid filingType query param is required" });
    return;
  }

  try {
    const result = await assignmentsService.getAvailableContractors(
      filingType as FilingType,
      req.firmId!,
    );
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const assignCase = async (req: AuthRequest, res: Response) => {
  const { assignmentType, filingType, urgencyLevel } =
    req.body as AssignCaseBody;

  if (!assignmentType || !filingType || !urgencyLevel) {
    res
      .status(400)
      .json({
        message: "assignmentType, filingType, and urgencyLevel are required",
      });
    return;
  }

  if (!VALID_FILING_TYPES.includes(filingType)) {
    res.status(400).json({ message: "Invalid filing type" });
    return;
  }

  try {
    const result = await assignmentsService.assignCase({
      ...req.body,
      firmId: req.firmId!,
    });
    res
      .status(201)
      .json({ message: "Case assigned successfully", assignment: result });
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};

export const getAllAssignments = async (req: AuthRequest, res: Response) => {
  try {
    const result = await assignmentsService.getAllAssignments(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const getAssignmentById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await assignmentsService.getAssignmentById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      res.status(404).json({ message: "Assignment not found" });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ message: (error as Error).message });
  }
};

export const updateAssignmentStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const { status } = req.body;

  if (!status) {
    res.status(400).json({ message: "status is required" });
    return;
  }

  try {
    const result = await assignmentsService.updateAssignmentStatus(
      req.params.id as string,
      req.firmId!,
      status,
    );
    if (!result) {
      res.status(404).json({ message: "Assignment not found" });
      return;
    }
    res
      .status(200)
      .json({ message: "Assignment status updated", assignment: result });
  } catch (error) {
    res.status(400).json({ message: (error as Error).message });
  }
};
