/**
 * @openapi
 * tags:
 *   - name: Workflow
 *     description: Workflow automation engine
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { requirePermission } from "../../middleware/permission.middleware";


import { validateRequest } from "../../middleware/validate.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { WorkflowController } from "./workflow.controller";
import { linkCaseBody } from "./workflow-template.validation";
import {
  caseIdParams,
  recordCaseMilestoneBody,
  formCodeParam,
  initializeCaseFormsBody,
  updateCaseFormBody,
  upsertImmigrationDetailsBody,
  upsertPersonalInjuryDetailsBody,
} from "./case-details.validation";

export class WorkflowRouter {
  public router: Router;
  public path: string;
  private workflowController: WorkflowController;
  private validation: CommonValidation;

  constructor(
    workflowController: WorkflowController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/cases";
    this.workflowController = workflowController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Both cross-case lists moved to /tasks:
    //   GET /tasks/my-tasks?source=workflow
    //   GET /tasks/review-queue?source=workflow

    /**
     * @openapi
     * /cases/{caseId}/workflow:
     *   get:
     *     tags: [Workflow]
     *     summary: Get or create the workflow for a case
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Workflow instance with modules and steps
     */
    this.router.get(
      "/:caseId/workflow",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getWorkflow,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/summary:
     *   get:
     *     tags: [Workflow]
     *     summary: Get workflow progress summary
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Workflow summary stats
     */
    this.router.get(
      "/:caseId/workflow/summary",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getWorkflowSummary,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/complete:
     *   post:
     *     tags: [Workflow]
     *     summary: Mark a workflow step as complete
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/complete",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.completeStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/submit-review:
     *   post:
     *     tags: [Workflow]
     *     summary: Submit a step for review (in_progress â†’ in_review)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/submit-review",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.submitForReview,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/approve:
     *   post:
     *     tags: [Workflow]
     *     summary: Approve a step (in_review â†’ completed)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/approve",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.approveStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/reject:
     *   post:
     *     tags: [Workflow]
     *     summary: Reject a step with feedback (in_review â†’ in_progress)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/reject",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.rejectStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/reopen:
     *   post:
     *     tags: [Workflow]
     *     summary: Reopen a rejected step (rejected → in_progress)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/reopen",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.reopenStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/review-thread:
     *   get:
     *     tags: [Workflow]
     *     summary: The step's submit/approve/reject/reopen note history
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Review events, oldest first
     */
    this.router.get(
      "/:caseId/workflow/steps/:stepId/review-thread",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.getStepReviewThread,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/assign:
     *   post:
     *     tags: [Workflow]
     *     summary: Assign a staff member to a step
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: stepId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/steps/:stepId/assign",
      requireAuth,
      validateRequest({
        params: this.validation.params("caseId", "stepId"),
        body: this.validation.requiredBody("staffId"),
      }),
      this.workflowController.assignStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/modules/{moduleId}/activate:
     *   post:
     *     tags: [Workflow]
     *     summary: Manually activate a module
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: moduleId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated workflow
     */
    this.router.post(
      "/:caseId/workflow/modules/:moduleId/activate",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "moduleId") }),
      this.workflowController.activateModule,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/timeline:
     *   get:
     *     tags: [Workflow]
     *     summary: Get timeline events for a case workflow
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Timeline events
     */
    this.router.get(
      "/:caseId/workflow/timeline",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getTimeline,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/logs:
     *   get:
     *     tags: [Workflow]
     *     summary: Get workflow audit logs for a case
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Audit log entries
     */
    this.router.get(
      "/:caseId/workflow/logs",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getLogs,
    );

    // â”€â”€ Case Notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes:
     *   get:
     *     tags: [Workflow]
     *     summary: Get case notes
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Case notes
     */
    this.router.get(
      "/:caseId/workflow/notes",
      requireAuth,
      requirePermission({ cases: ["read"] }),
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getNotes,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes:
     *   post:
     *     tags: [Workflow]
     *     summary: Create a case note
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       201:
     *         description: Created note
     */
    this.router.post(
      "/:caseId/workflow/notes",
      requireAuth,
      validateRequest({
        params: this.validation.params("caseId"),
        body: this.validation.requiredBody("content"),
      }),
      this.workflowController.createNote,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes/{noteId}:
     *   patch:
     *     tags: [Workflow]
     *     summary: Update a case note
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: noteId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Updated note
     */
    this.router.patch(
      "/:caseId/workflow/notes/:noteId",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "noteId") }),
      this.workflowController.updateNote,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes/{noteId}:
     *   delete:
     *     tags: [Workflow]
     *     summary: Delete a case note
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: noteId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       204:
     *         description: Deleted
     */
    this.router.delete(
      "/:caseId/workflow/notes/:noteId",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "noteId") }),
      this.workflowController.deleteNote,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes/{noteId}/toggle-pin:
     *   post:
     *     tags: [Workflow]
     *     summary: Toggle pin status of a case note
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: path
     *         name: noteId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Pin status toggled
     */
    this.router.post(
      "/:caseId/workflow/notes/:noteId/toggle-pin",
      requireAuth,
      validateRequest({ params: this.validation.params("caseId", "noteId") }),
      this.workflowController.toggleNotePin,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes/bulk-delete:
     *   post:
     *     tags: [Workflow]
     *     summary: Bulk delete case notes
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               noteIds:
     *                 type: array
     *                 items:
     *                   type: string
     *     responses:
     *       200:
     *         description: Notes deleted
     */
    this.router.post(
      "/:caseId/workflow/notes/bulk-delete",
      requireAuth,
      validateRequest({
        params: this.validation.params("caseId"),
        body: this.validation.requiredBody("noteIds"),
      }),
      this.workflowController.bulkDeleteNotes,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/notes/bulk-pin:
     *   post:
     *     tags: [Workflow]
     *     summary: Bulk pin/unpin case notes
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               noteIds:
     *                 type: array
     *                 items:
     *                   type: string
     *               isPinned:
     *                 type: boolean
     *     responses:
     *       200:
     *         description: Notes pinned/unpinned
     */
    this.router.post(
      "/:caseId/workflow/notes/bulk-pin",
      requireAuth,
      validateRequest({
        params: this.validation.params("caseId"),
        body: this.validation.requiredBody("noteIds", "isPinned"),
      }),
      this.workflowController.bulkPinNotes,
    );

    /**
     * @openapi
     * /cases/{caseId}/mandamus-candidacy:
     *   get:
     *     tags: [Workflow]
     *     summary: Days pending vs. USCIS median, per outstanding form
     *     description: >
     *       A triage heuristic for an attorney to read. One entry per core form
     *       still awaiting adjudication, each measured against its own median
     *       from its own filing date, longest-overdue first; `mostDelayed` is
     *       the form an action would be brought over. `delayRatio` is null when
     *       no processing-time reference matches — unknown, not "not delayed".
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Candidacy figures
     */
    this.router.get(
      "/:caseId/mandamus-candidacy",
      requirePermission("cases", "read"),
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getMandamusCandidacy,
    );

    /**
     * @openapi
     * /cases/{caseId}/link:
     *   post:
     *     tags: [Workflow]
     *     summary: Link an existing case to this one as a mandamus/appeal/related matter
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [childCaseId, relationType]
     *             properties:
     *               childCaseId: { type: string, format: uuid }
     *               relationType:
     *                 type: string
     *                 enum: [mandamus, appeal, related_matter]
     *     responses:
     *       201:
     *         description: Case linked
     *   delete:
     *     tags: [Workflow]
     *     summary: Remove this case's link to its parent
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: Case unlinked
     */
    this.router.post(
      "/:caseId/link",
      requirePermission("cases", "update"),
      validateRequest({
        params: this.validation.params("caseId"),
        body: linkCaseBody,
      }),
      this.workflowController.linkCase,
    );

    this.router.delete(
      "/:caseId/link",
      requirePermission("cases", "update"),
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.unlinkCase,
    );

    /**
     * @openapi
     * /cases/{caseId}/immigration-details:
     *   get:
     *     tags: [Workflow]
     *     summary: The case's immigration extension fields, or null if not recorded yet
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Immigration details, or null
     *   put:
     *     tags: [Workflow]
     *     summary: Create or update the case's immigration extension fields
     *     description: >
     *       Writing a condition field (`filingTrack`, `naturalizationTrack`,
     *       `isConditionalResidence`) re-runs task materialization; writing an
     *       anchor field re-resolves open tasks' due dates; logging both RFE
     *       dates schedules the response reminders. Which forms the matter
     *       files is not recorded here — see `/cases/{caseId}/forms`.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200: { description: Saved }
     *       400: { description: rfeDeadline not after rfeIssuedDate }
     *
     * /cases/{caseId}/personal-injury-details:
     *   get:
     *     tags: [Workflow]
     *     summary: The case's personal-injury extension fields, or null if not recorded yet
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Personal injury details, or null
     *   put:
     *     tags: [Workflow]
     *     summary: Create or update the case's personal-injury extension fields
     *     description: >
     *       Writing `defendantType` or `isMinorPlaintiff` re-runs task
     *       materialization; writing an anchor field (`mmiDate`, `incidentDate`,
     *       the litigation milestones) re-resolves open tasks' due dates.
     *       `incidentDate` is required on the first write.
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200: { description: Saved }
     *       400: { description: incidentDate missing on first write }
     */

    // These are case fields that happen to live in an extension table, so they
    // carry the `cases` permission rather than `tasks` — even though writing
    // one can create tasks as a side effect.
    this.router.get(
      "/:caseId/immigration-details",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getImmigrationDetails,
    );

    this.router.put(
      "/:caseId/immigration-details",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: upsertImmigrationDetailsBody }),
      this.workflowController.upsertImmigrationDetails,
    );

    /**
     * @openapi
     * /cases/{caseId}/milestones:
     *   get:
     *     tags: [Cases]
     *     summary: The case chronology - what the agency did, and when
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200: { description: Milestones, oldest first }
     *   post:
     *     tags: [Cases]
     *     summary: Record a milestone from a USCIS notice
     *     description: >
     *       Writes the chronology row, projects the date onto the case's
     *       immigration details, keeps the calendar event for appointment
     *       milestones in step, and re-resolves every task anchored on that
     *       date. Recording the same milestone again corrects it in place and
     *       is audited as a correction.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [milestone, occurredOn]
     *             properties:
     *               milestone:
     *                 type: string
     *                 enum: [receipt, biometrics_appointment, interview_scheduled, decision, card_valid_to, green_card_expiration]
     *               occurredOn: { type: string, format: date }
     *               noticeNumber: { type: string, nullable: true }
     *               note: { type: string, nullable: true }
     *     responses:
     *       201: { description: Recorded }
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:caseId/milestones",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.listCaseMilestones,
    );

    this.router.post(
      "/:caseId/milestones",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: recordCaseMilestoneBody }),
      this.workflowController.recordCaseMilestone,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms:
     *   get:
     *     tags: [Cases]
     *     summary: The matter's filing package, one entry per form
     *     description: >
     *       A concurrent adjustment filing is four core forms plus two
     *       supporting documents, each with its own edition, fee, receipt
     *       number and adjudication. Returned in filing order with a progress
     *       rollup, so "is the I-765 filed?" is answerable rather than only
     *       "is the package filed?".
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200: { description: Forms and progress }
     *       404: { description: Case not found }
     *   post:
     *     tags: [Cases]
     *     summary: Set up the filing package on a matter
     *     description: >
     *       Additive and idempotent. A form already on the matter keeps
     *       whatever state it has reached; only missing rows are created.
     *       Omit `forms` for the standard adjustment package.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       201: { description: Package set up }
     */
    this.router.get(
      "/:caseId/forms",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.listCaseForms,
    );

    this.router.post(
      "/:caseId/forms",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: initializeCaseFormsBody }),
      this.workflowController.initializeCaseForms,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}:
     *   patch:
     *     tags: [Cases]
     *     summary: Update one form's standing
     *     description: >
     *       Recording a receipt number on a form not yet marked filed moves it
     *       to `receipted` — an I-797C number is evidence it was. A supporting
     *       document (I-864, I-693) is refused a receipt number: USCIS issues
     *       none, as it is adjudicated with the filing it accompanies.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *       - in: path
     *         name: formCode
     *         required: true
     *         schema: { type: string, example: I-485 }
     *     responses:
     *       200: { description: Updated }
     *       400: { description: Receipt number on a supporting document }
     *       404: { description: Form not on this matter }
     *   delete:
     *     tags: [Cases]
     *     summary: Remove a form from the matter
     *     description: >
     *       Only before it reaches USCIS. A filed form is part of the record of
     *       what was sent, so it is withdrawn by status rather than deleted.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *       - in: path
     *         name: formCode
     *         required: true
     *         schema: { type: string, example: I-131 }
     *     responses:
     *       200: { description: Removed }
     *       400: { description: Already filed - withdraw it instead }
     */
    this.router.patch(
      "/:caseId/forms/:formCode",
      requirePermission("cases", "update"),
      validateRequest({ params: formCodeParam, body: updateCaseFormBody }),
      this.workflowController.updateCaseForm,
    );

    this.router.delete(
      "/:caseId/forms/:formCode",
      requirePermission("cases", "update"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.removeCaseForm,
    );

    /**
     * @openapi
     * /cases/{caseId}/pitfalls:
     *   get:
     *     tags: [Workflow]
     *     summary: The § 1.5 validation checks for a matter
     *     description: >
     *       Computed on demand, never stored — every rule reads fields that
     *       change, and a stored warning goes stale the moment one does.
     *       Exactly one check can block (a superseded form edition, which USCIS
     *       rejects outright); the rest are warnings for an attorney to weigh,
     *       because they turn on facts the system cannot see.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200:
     *         description: Zero or more pitfalls, most consequential first
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:caseId/pitfalls",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getCasePitfalls,
    );

    /**
     * @openapi
     * /cases/{caseId}/filing-fees:
     *   get:
     *     tags: [Workflow]
     *     summary: USCIS fees for the AOS package, at this matter's filing date
     *     description: >
     *       Quoted against the case's own filing date, so a matter filed before
     *       a fee change keeps quoting the fee that actually applied. Forms
     *       filed alongside the I-485 get the concurrent rate — an I-765 is $260
     *       that way and $520 standalone.
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string, format: uuid }
     *     responses:
     *       200: { description: One quote per form with a fee on record }
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:caseId/filing-fees",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getCaseFilingFees,
    );

    this.router.get(
      "/:caseId/personal-injury-details",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getPersonalInjuryDetails,
    );

    this.router.put(
      "/:caseId/personal-injury-details",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: upsertPersonalInjuryDetailsBody }),
      this.workflowController.upsertPersonalInjuryDetails,
    );
  }
}
