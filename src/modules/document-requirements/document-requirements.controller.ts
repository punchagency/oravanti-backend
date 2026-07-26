import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import { sendSuccess } from "../../utils/send-success";
import { DocumentRequirementsService } from "./document-requirements.service";

export class DocumentRequirementsController {
  constructor(private readonly svc: DocumentRequirementsService) {}

  list = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const rows = await this.svc.listByCaseType(
      organizationId!,
      req.query.caseTypeId as string,
    );
    sendSuccess(res, rows, "Requirement templates retrieved");
  };

  create = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const row = await this.svc.create(organizationId!, req.body);
    sendSuccess(res, row, "Requirement template created", 201);
  };

  update = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const row = await this.svc.update(
      organizationId!,
      req.params.id as string,
      req.body,
    );
    sendSuccess(res, row, "Requirement template updated");
  };

  archive = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.archive(
      organizationId!,
      req.params.id as string,
    );
    sendSuccess(res, result, "Requirement template archived");
  };
}
