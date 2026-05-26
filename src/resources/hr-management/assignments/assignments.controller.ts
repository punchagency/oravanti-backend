import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
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
    throw new BadRequestError("A valid filingType query param is required");
  }

  try {
    const result = await assignmentsService.getAvailableContractors(
      filingType as FilingType,
      req.firmId!,
    );
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const assignCase = async (req: AuthRequest, res: Response) => {
  const { assignmentType, filingType, urgencyLevel } =
    req.body as AssignCaseBody;

  if (!assignmentType || !filingType || !urgencyLevel) {
    throw new BadRequestError(
      "assignmentType, filingType, and urgencyLevel are required",
    );
  }

  if (!VALID_FILING_TYPES.includes(filingType)) {
    throw new BadRequestError("Invalid filing type");
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
    sendErrorResponse(res, error, 400);
  }
};

export const getAllAssignments = async (req: AuthRequest, res: Response) => {
  try {
    const result = await assignmentsService.getAllAssignments(req.firmId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const getAssignmentById = async (req: AuthRequest, res: Response) => {
  try {
    const result = await assignmentsService.getAssignmentById(
      req.params.id as string,
      req.firmId!,
    );
    if (!result) {
      throw new NotFoundError("Assignment not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateAssignmentStatus = async (
  req: AuthRequest,
  res: Response,
) => {
  const { status } = req.body;

  if (!status) {
    throw new BadRequestError("status is required");
  }

  try {
    const result = await assignmentsService.updateAssignmentStatus(
      req.params.id as string,
      req.firmId!,
      status,
    );
    if (!result) {
      throw new NotFoundError("Assignment not found");
    }
    res
      .status(200)
      .json({ message: "Assignment status updated", assignment: result });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};
