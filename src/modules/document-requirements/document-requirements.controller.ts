import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { sendSuccess } from "../../utils/send-success";
import { DocumentRequirementsService } from "./document-requirements.service";

export class DocumentRequirementsController {
  constructor(private readonly svc: DocumentRequirementsService) {}

  list = async (req: AuthRequest, res: Response) => {
    const rows = await this.svc.listByCaseType(
      req.organizationId!,
      req.query.caseTypeId as string,
    );
    sendSuccess(res, rows, "Requirement templates retrieved");
  };

  create = async (req: AuthRequest, res: Response) => {
    const row = await this.svc.create(req.organizationId!, req.body);
    sendSuccess(res, row, "Requirement template created", 201);
  };

  update = async (req: AuthRequest, res: Response) => {
    const row = await this.svc.update(
      req.organizationId!,
      req.params.id as string,
      req.body,
    );
    sendSuccess(res, row, "Requirement template updated");
  };

  archive = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.archive(
      req.organizationId!,
      req.params.id as string,
    );
    sendSuccess(res, result, "Requirement template archived");
  };
}
