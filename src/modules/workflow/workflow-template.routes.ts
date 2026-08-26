/**
 * @openapi
 * tags:
 *   - name: Workflow templates
 *     description: The per-case-type blueprints tasks are materialized from
 *
 * paths:
 *   /workflow-templates/:
 *     get:
 *       tags: [Workflow templates]
 *       summary: Resolve the template for a case type (firm override, else system default)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: caseTypeId
 *           required: true
 *           schema: { type: string, format: uuid }
 *       responses:
 *         200: { description: Template with its modules and steps }
 *         404: { description: No template for this case type }
 *
 *   /workflow-templates/{id}/clone:
 *     post:
 *       tags: [Workflow templates]
 *       summary: Clone a system-default template into the firm's own copy
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string, format: uuid }
 *       responses:
 *         201: { description: Cloned template }
 *
 *   /workflow-templates/{id}/modules/{moduleId}:
 *     patch:
 *       tags: [Workflow templates]
 *       summary: Edit a module on the firm's own template
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string, format: uuid }
 *         - in: path
 *           name: moduleId
 *           required: true
 *           schema: { type: string, format: uuid }
 *       responses:
 *         200: { description: Module updated }
 *         403: { description: Template is a shared system default — clone it first }
 */
import { Router } from "express";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { WorkflowTemplateController } from "./workflow-template.controller";
import { templateQuery, updateModuleBody } from "./workflow-template.validation";

export class WorkflowTemplateRouter {
  public router: Router;
  public path: string;

  constructor(controller: WorkflowTemplateController) {
    this.router = Router();
    this.path = "/workflow-templates";

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Reading the blueprint is part of reading the work it produces — held by
    // everyone who works a matter, down to the legal assistant.
    this.router.get(
      "/",
      requirePermission("workflow", "read"),
      validateRequest({ query: templateQuery }),
      controller.getResolved,
    );

    // Editing a template changes every future matter of that type, so
    // `workflow:update` is granted to owner and admin only — the plan's
    // requireOwnerOrAdmin, expressed as a permission a firm can see and audit
    // rather than a hardcoded role check.
    this.router.post(
      "/:id/clone",
      requirePermission("workflow", "update"),
      validateRequest({ params: z.object({ id: z.string().uuid() }) }),
      controller.clone,
    );

    this.router.patch(
      "/:id/modules/:moduleId",
      requirePermission("workflow", "update"),
      validateRequest({
        params: z.object({ id: z.string().uuid(), moduleId: z.string().uuid() }),
        body: updateModuleBody,
      }),
      controller.updateModule,
    );
  }
}
