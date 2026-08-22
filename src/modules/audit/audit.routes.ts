/**
 * @openapi
 * tags:
 *   - name: Audit
 *     description: The firm-wide audit trail — who did what, when, from where
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { AuditController } from "./audit.controller";
import {
  entityFeedParamsSchema,
  entityFeedQuerySchema,
  exportAuditEventsQuerySchema,
  listAuditEventsQuerySchema,
  requestIdParamsSchema,
} from "./audit.validation";

export class AuditRouter {
  public router: Router;
  public path: string;
  private controller: AuditController;

  constructor(controller: AuditController) {
    this.router = Router();
    this.path = "/audit-events";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;

    /*
      Owner/admin only, via the `audit` resource.

      Not `requireResource("audit")`, which would derive the action from the
      HTTP method and make every GET a `read` — including the export, which is
      a GET that takes copies of firm records out of the system and deserves
      its own grant.
    */
    this.router.use(requireAuth, resolveActorContext);

    const read = requirePermission({ audit: ["read"] });
    const exportTrail = requirePermission({ audit: ["export"] });

    /**
     * @openapi
     * /audit-events:
     *   get:
     *     tags: [Audit]
     *     summary: List audit events, newest first, page/limit-paginated
     *     description: >
     *       Access events (views, downloads) are excluded unless `category=access`
     *       is passed — they outnumber state changes by orders of magnitude.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: category
     *         schema: { type: string, enum: [business, security, admin, system, access] }
     *       - in: query
     *         name: action
     *         schema: { type: string }
     *         description: An exact registry action, e.g. `lead.stage_changed`
     *       - in: query
     *         name: domain
     *         schema: { type: string }
     *         description: Everything in one domain, e.g. `lead`
     *       - in: query
     *         name: entityType
     *         schema: { type: string }
     *       - in: query
     *         name: entityId
     *         schema: { type: string }
     *       - in: query
     *         name: actorId
     *         schema: { type: string }
     *       - in: query
     *         name: actorStaffId
     *         schema: { type: string, format: uuid }
     *       - in: query
     *         name: from
     *         schema: { type: string, format: date-time }
     *       - in: query
     *         name: to
     *         schema: { type: string, format: date-time }
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *         description: Free text over the stored summary
     *       - in: query
     *         name: page
     *         schema: { type: integer, minimum: 1, default: 1 }
     *       - in: query
     *         name: limit
     *         schema: { type: integer, maximum: 100, default: 50 }
     *     responses:
     *       200:
     *         description: A page of audit events, with `pagination`
     */
    this.router.get(
      "/",
      read,
      validateRequest({ query: listAuditEventsQuerySchema }),
      controller.listEvents,
    );

    /**
     * @openapi
     * /audit-events/filters:
     *   get:
     *     tags: [Audit]
     *     summary: Actions, domains and categories present in this firm's trail
     *     description: >
     *       Driven by the rows that exist rather than by the registry, so the
     *       filter controls list what has actually happened here.
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: Facet counts for the filter controls
     */
    this.router.get("/filters", read, controller.getFacets);

    /**
     * @openapi
     * /audit-events/export:
     *   get:
     *     tags: [Audit]
     *     summary: Export the filtered trail as CSV or PDF
     *     description: >
     *       Accepts the same filters as the list endpoint. Capped at 10,000
     *       rows. `before`/`after` are omitted from the file by design.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: query
     *         name: format
     *         schema: { type: string, enum: [csv, pdf], default: csv }
     *     responses:
     *       200:
     *         description: The exported file
     */
    this.router.get(
      "/export",
      exportTrail,
      validateRequest({ query: exportAuditEventsQuerySchema }),
      controller.exportEvents,
    );

    /**
     * @openapi
     * /audit-events/request/{requestId}:
     *   get:
     *     tags: [Audit]
     *     summary: Everything one request did, by correlation id
     *     description: >
     *       The access log gives you a `requestId`; this turns it into the list
     *       of state changes that one call made.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: requestId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Every audit event sharing that request id
     */
    this.router.get(
      "/request/:requestId",
      read,
      validateRequest({ params: requestIdParamsSchema }),
      controller.listByRequestId,
    );

    /**
     * @openapi
     * /audit-events/entity/{entityType}/{entityId}:
     *   get:
     *     tags: [Audit]
     *     summary: One entity's activity — changes and views together
     *     description: >
     *       Matches `parentEntityId` as well as `entityId`, so a note recorded
     *       against a matter appears on the matter's feed. Unlike the firm-wide
     *       list, access events are included by default.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: entityType
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: entityId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: category
     *         schema: { type: string, enum: [business, security, admin, system, access] }
     *       - in: query
     *         name: limit
     *         schema: { type: integer, maximum: 100, default: 50 }
     *       - in: query
     *         name: cursor
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: A page of that entity's activity
     */
    this.router.get(
      "/entity/:entityType/:entityId",
      read,
      validateRequest({
        params: entityFeedParamsSchema,
        query: entityFeedQuerySchema,
      }),
      controller.listForEntity,
    );
  }
}
