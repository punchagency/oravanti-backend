/**
 * @openapi
 * tags:
 *   - name: Finance — Invoicing
 *     description: Invoices, payments and payment follow-ups
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { InvoicesController } from "./invoices.controller";
import {
  activityQuerySchema,
  caseDefaultsQuerySchema,
  createInvoiceBodySchema,
  createLinePresetBodySchema,
  exportInvoicesQuerySchema,
  extendDueDateBodySchema,
  followUpBodySchema,
  invoiceParamsSchema,
  paymentParamsSchema,
  listInvoicesQuerySchema,
  listLinePresetsQuerySchema,
  recordPaymentBodySchema,
  refundPaymentBodySchema,
  setScheduleBodySchema,
  unbilledTimeQuerySchema,
  updateInvoiceBodySchema,
  voidInvoiceBodySchema,
} from "./invoices.validation";

export class InvoicesRouter {
  public router: Router;
  public path: string;
  private controller: InvoicesController;

  constructor(controller: InvoicesController) {
    this.router = Router();
    this.path = "/finance/invoices";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;

    // Auth + actor context for the whole tab; permission varies per route.
    this.router.use(requireAuth, resolveActorContext);

    const read = requirePermission({ finance: ["read"] });
    const create = requirePermission({ finance: ["create"] });
    const update = requirePermission({ finance: ["update"] });
    const recordPayment = requirePermission({ finance: ["record_payment"] });
    // Deliberately not `record_payment`. Owner and admin only — recording a
    // payment wrongly is corrected from the same screen, whereas a refund moves
    // money out of the firm's account and cannot be taken back.
    const refund = requirePermission({ finance: ["refund"] });

    // ── Static paths FIRST ───────────────────────────────────────────────────
    // Express 5 matches in declaration order, so any of these declared after
    // `GET /:id` would be swallowed by it and fail uuid validation.

    /**
     * @openapi
     * /finance/invoices/stats:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: Invoice totals for the firm (excludes drafts and voids)
     *     responses:
     *       200: { description: Stats retrieved }
     */
    this.router.get("/stats", read, controller.getStats);

    /**
     * @openapi
     * /finance/invoices/aging:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: Outstanding balance bucketed by age
     *     responses:
     *       200: { description: Aging summary retrieved }
     */
    this.router.get("/aging", read, controller.getAging);

    /**
     * @openapi
     * /finance/invoices/activity:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: Recent finance activity feed
     *     responses:
     *       200: { description: Activity retrieved }
     */
    this.router.get(
      "/activity",
      read,
      validateRequest({ query: activityQuerySchema }),
      controller.getActivity,
    );

    /**
     * @openapi
     * /finance/invoices/unbilled-time:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: Approved, unbilled time entries available to invoice
     *     responses:
     *       200: { description: Unbilled time retrieved }
     */
    this.router.get(
      "/unbilled-time",
      create,
      validateRequest({ query: unbilledTimeQuerySchema }),
      controller.getUnbilledTime,
    );

    /**
     * @openapi
     * /finance/invoices/case-defaults:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: The attorney to bill a matter under, resolved from its team
     *     description: >
     *       A case is assigned to a team, not a person. Prefers the team lead
     *       when they are an attorney, then the team's only attorney, then the
     *       lead whatever their role. `source` says which rule fired.
     *     responses:
     *       200: { description: Matter defaults retrieved }
     */
    this.router.get(
      "/case-defaults",
      create,
      validateRequest({ query: caseDefaultsQuerySchema }),
      controller.getCaseDefaults,
    );

    /**
     * @openapi
     * /finance/invoices/line-presets:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: The catalog manual invoice lines are composed from
     *     description: >
     *       Returns the shipped catalog plus this firm's own entries, narrowed
     *       to the matter's case type and practice area and widened outward:
     *       case-type presets, then practice-area, then unscoped. `rank` says
     *       which matched. Trust presets are omitted for callers who cannot
     *       write trust lines.
     *     responses:
     *       200: { description: Line presets retrieved }
     */
    this.router.get(
      "/line-presets",
      create,
      validateRequest({ query: listLinePresetsQuerySchema }),
      controller.getLinePresets,
    );

    /**
     * @openapi
     * /finance/invoices/line-presets:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Save a custom line to the firm's own list
     *     description: >
     *       Creates a firm-owned preset. Re-saving the same name in the same
     *       scope updates its amount rather than failing. Cannot create or
     *       modify a shipped preset — RLS refuses the write.
     *     responses:
     *       201: { description: Line preset saved }
     */
    this.router.post(
      "/line-presets",
      create,
      validateRequest({ body: createLinePresetBodySchema }),
      controller.createLinePreset,
    );

    /**
     * @openapi
     * /finance/invoices/export:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: Export the filtered invoice list as CSV or PDF
     *     responses:
     *       200: { description: File stream }
     */
    this.router.get(
      "/export",
      read,
      validateRequest({ query: exportInvoicesQuerySchema }),
      controller.export,
    );

    // ── Collection ───────────────────────────────────────────────────────────

    /**
     * @openapi
     * /finance/invoices:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: List invoices with status/account filters and search
     *     responses:
     *       200: { description: Invoices retrieved }
     */
    this.router.get(
      "/",
      read,
      validateRequest({ query: listInvoicesQuerySchema }),
      controller.list,
    );

    /**
     * @openapi
     * /finance/invoices:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Create an invoice from manual lines and/or approved time entries
     *     responses:
     *       201: { description: Invoice created }
     */
    this.router.post(
      "/",
      create,
      validateRequest({ body: createInvoiceBodySchema }),
      controller.create,
    );

    // ── Item ─────────────────────────────────────────────────────────────────

    this.router.get(
      "/:id",
      read,
      validateRequest({ params: invoiceParamsSchema }),
      controller.getById,
    );

    /**
     * @openapi
     * /finance/invoices/{id}:
     *   patch:
     *     tags: [Finance — Invoicing]
     *     summary: Edit an invoice; line/matter/date edits are draft-only
     *     description: >
     *       Due date, notes, attorney and filing type apply to any live
     *       invoice. Changing what the invoice charges — lines, time entries,
     *       matter, issue date — is refused on anything but a draft: a sent
     *       invoice is corrected by voiding and reissuing, not by rewriting a
     *       document the client already holds. Sending `lineItems` replaces the
     *       whole line set, so `timeEntryIds` must accompany it.
     *     responses:
     *       200: { description: Invoice updated }
     *       400: { description: Not a draft, or the line set is incomplete }
     */
    this.router.patch(
      "/:id",
      update,
      validateRequest({
        params: invoiceParamsSchema,
        body: updateInvoiceBodySchema,
      }),
      controller.update,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/schedule:
     *   put:
     *     tags: [Finance — Invoicing]
     *     summary: Set or revise the payment schedule
     *     description: >
     *       Replaces the whole schedule. Allowed on a draft, sent or partly
     *       paid invoice — plans get renegotiated, and a revision is recorded
     *       as its own event. Refused once the invoice is paid or void. The
     *       instalments must sum to the invoice total; the header due date is
     *       pinned to the final instalment. `sequence` is assigned by the
     *       server in due-date order, not accepted from the client.
     *     responses:
     *       200: { description: Schedule saved }
     *       400: { description: Paid/void, or the rows do not sum to the total }
     *   delete:
     *     tags: [Finance — Invoicing]
     *     summary: Remove the schedule; the invoice reverts to one due date
     */
    this.router.put(
      "/:id/schedule",
      update,
      validateRequest({
        params: invoiceParamsSchema,
        body: setScheduleBodySchema,
      }),
      controller.setSchedule,
    );

    this.router.delete(
      "/:id/schedule",
      update,
      validateRequest({ params: invoiceParamsSchema }),
      controller.removeSchedule,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/pdf:
     *   get:
     *     tags: [Finance — Invoicing]
     *     summary: The invoice PDF — the only renderer, also what gets emailed
     */
    this.router.get(
      "/:id/pdf",
      read,
      validateRequest({ params: invoiceParamsSchema }),
      controller.pdf,
    );

    this.router.get(
      "/:id/deliveries",
      read,
      validateRequest({ params: invoiceParamsSchema }),
      controller.getDeliveries,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/send:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Email a draft invoice to the client and record the attempt
     *     description: >
     *       Archives the PDF, records the attempt, then sends. The invoice is
     *       only promoted out of draft once the provider accepts the message —
     *       a failure leaves it a draft with the reason recorded.
     *     responses:
     *       201: { description: Attempt recorded (check `status`) }
     */
    this.router.post(
      "/:id/send",
      update,
      validateRequest({ params: invoiceParamsSchema }),
      controller.send,
    );

    this.router.post(
      "/:id/resend",
      update,
      validateRequest({ params: invoiceParamsSchema }),
      controller.resend,
    );

    this.router.post(
      "/:id/void",
      update,
      validateRequest({
        params: invoiceParamsSchema,
        body: voidInvoiceBodySchema,
      }),
      controller.void,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/extend-due-date:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Give the client longer to pay
     *     description: >
     *       Moves the due date forward on a live, unsettled invoice — stored
     *       `sent` or `partial`, which includes anything currently overdue.
     *       Forward only: a date on or before the current one is refused, since
     *       an extension that can shorten is not an extension. Refused on a
     *       draft (edit it instead), on a settled invoice, on a void, and on an
     *       invoice with a payment schedule, whose header date is pinned to the
     *       final instalment and must be changed by revising the schedule.
     *     responses:
     *       200: { description: Due date extended }
     *       400: { description: Not extendable, scheduled, or not a later date }
     */
    this.router.post(
      "/:id/extend-due-date",
      update,
      validateRequest({
        params: invoiceParamsSchema,
        body: extendDueDateBodySchema,
      }),
      controller.extendDueDate,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/payments:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Record a payment; splits operating/trust, pro-rata by default
     *     responses:
     *       201: { description: Payment recorded }
     */
    this.router.post(
      "/:id/payments",
      recordPayment,
      validateRequest({
        params: invoiceParamsSchema,
        body: recordPaymentBodySchema,
      }),
      controller.recordPayment,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/payments/{paymentId}/refund:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Send a payment back; voids it if it has not settled yet
     *     responses:
     *       201: { description: Refund issued or payment voided }
     */
    this.router.post(
      "/:id/payments/:paymentId/refund",
      refund,
      validateRequest({
        params: paymentParamsSchema,
        body: refundPaymentBodySchema,
      }),
      controller.refundPayment,
    );

    /**
     * @openapi
     * /finance/invoices/{id}/follow-up:
     *   post:
     *     tags: [Finance — Invoicing]
     *     summary: Send a payment follow-up by email and/or SMS
     *     responses:
     *       201: { description: Follow-up sent }
     */
    this.router.post(
      "/:id/follow-up",
      recordPayment,
      validateRequest({
        params: invoiceParamsSchema,
        body: followUpBodySchema,
      }),
      controller.sendFollowUp,
    );
  }
}
