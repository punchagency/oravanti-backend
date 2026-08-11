/**
 * @openapi
 * tags:
 *   - name: Finance — Time & Billing
 *     description: Time entries, approvals, earnings and billing rates
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { TimeBillingController } from "./time-billing.controller";
import {
  createTimeEntryBodySchema,
  exportTimeEntriesQuerySchema,
  listTimeEntriesQuerySchema,
  periodQuerySchema,
  rejectTimeEntryBodySchema,
  setBillingRateBodySchema,
  timeEntryParamsSchema,
  topMattersQuerySchema,
  updateTimeEntryBodySchema,
} from "./time-billing.validation";

export class TimeBillingRouter {
  public router: Router;
  public path: string;
  private controller: TimeBillingController;

  constructor(controller: TimeBillingController) {
    this.router = Router();
    this.path = "/finance/time-entries";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;

    this.router.use(requireAuth, resolveActorContext);

    const read = requirePermission({ finance: ["read"] });
    const logTime = requirePermission({ finance: ["log_time"] });
    const approveTime = requirePermission({ finance: ["approve_time"] });

    // Static paths before /:id — Express 5 matches in declaration order.

    this.router.get(
      "/stats",
      read,
      validateRequest({ query: periodQuerySchema }),
      controller.getStats,
    );

    this.router.get(
      "/earnings-by-staff",
      read,
      validateRequest({ query: periodQuerySchema }),
      controller.getEarningsByStaff,
    );

    this.router.get(
      "/top-matters",
      read,
      validateRequest({ query: topMattersQuerySchema }),
      controller.getTopMatters,
    );

    this.router.get(
      "/export",
      read,
      validateRequest({ query: exportTimeEntriesQuerySchema }),
      controller.export,
    );

    /**
     * @openapi
     * /finance/time-entries/billing-rates:
     *   get:
     *     tags: [Finance — Time & Billing]
     *     summary: Rate history for the firm
     *   post:
     *     tags: [Finance — Time & Billing]
     *     summary: Record a new effective-dated rate (closes the open one)
     */
    // Setting rates decides what everyone's work is worth, so it sits behind
    // the same permission as approving their time.
    this.router.get("/billing-rates", read, controller.listRates);
    this.router.post(
      "/billing-rates",
      approveTime,
      validateRequest({ body: setBillingRateBodySchema }),
      controller.setRate,
    );

    this.router.get(
      "/",
      read,
      validateRequest({ query: listTimeEntriesQuerySchema }),
      controller.list,
    );

    this.router.post(
      "/",
      logTime,
      validateRequest({ body: createTimeEntryBodySchema }),
      controller.create,
    );

    this.router.patch(
      "/:id",
      logTime,
      validateRequest({
        params: timeEntryParamsSchema,
        body: updateTimeEntryBodySchema,
      }),
      controller.update,
    );

    this.router.post(
      "/:id/approve",
      approveTime,
      validateRequest({ params: timeEntryParamsSchema }),
      controller.approve,
    );

    this.router.post(
      "/:id/reject",
      approveTime,
      validateRequest({
        params: timeEntryParamsSchema,
        body: rejectTimeEntryBodySchema,
      }),
      controller.reject,
    );
  }
}
