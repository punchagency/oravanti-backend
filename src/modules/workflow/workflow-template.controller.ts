import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import {
  cloneTemplateForOrganization,
  loadTemplateWithModulesAndSteps,
  resolveWorkflowTemplateId,
  updateTemplateModule,
} from "./workflow-template.service";

export class WorkflowTemplateController {
  /**
   * The template a case of this type would actually materialize from — the
   * firm's own if they have one, otherwise the system default. Returns the
   * modules and steps too, since every caller needs the tree, and knowing
   * which steps are locked is what tells the UI what a firm may edit.
   */
  getResolved = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseTypeId = String(req.query.caseTypeId);

    const templateId = await resolveWorkflowTemplateId(organizationId!, caseTypeId);
    if (!templateId) throw new NotFoundError(`No workflow template for case type ${caseTypeId}`);

    sendSuccess(res, await loadTemplateWithModulesAndSteps(templateId), "Workflow template retrieved successfully");
  });

  /** A firm's first edit to a system default clones it rather than mutating the shared row. */
  clone = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();

    const clonedId = await cloneTemplateForOrganization(String(req.params.id), organizationId!, staffId ?? null);

    sendSuccess(res, await loadTemplateWithModulesAndSteps(clonedId), "Workflow template cloned successfully", 201);
  });

  updateModule = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();

    const updated = await updateTemplateModule(
      String(req.params.moduleId),
      organizationId!,
      req.body,
      staffId ?? null,
    );

    sendSuccess(res, updated, "Workflow module updated successfully");
  });
}
