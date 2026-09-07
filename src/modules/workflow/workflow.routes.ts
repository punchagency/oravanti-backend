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
  addCaseFormBody,
  formCodeParam,
  formFieldParam,
  setFormFieldBody,
  correctionParam,
  correctionCommentBody,
  correctionNoteBody,
  raiseCorrectionBody,
  setFormFieldsBody,
  populateFormsBody,
  formRevisionParam,
  formVersionParam,
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
      validateRequest({
        params: caseIdParams,
        body: upsertImmigrationDetailsBody,
      }),
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
    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}:
     *   post:
     *     tags: [Cases]
     *     summary: Put a published form on this matter
     *     description: >
     *       For the form the workflow template did not anticipate — an I-765 on
     *       a matter that was not going to file one. The form must be one
     *       Oravanti publishes; a firm does not author forms, so an unknown
     *       code is a 404 rather than an invitation to name it.
     *     responses:
     *       201: { description: Added }
     *       400: { description: Already on this matter }
     *       404: { description: Not a form Oravanti publishes }
     */
    this.router.post(
      "/:caseId/forms/:formCode",
      requirePermission("cases", "update"),
      validateRequest({ params: formCodeParam, body: addCaseFormBody }),
      this.workflowController.addCaseForm,
    );

    /**
     * @openapi
     * /cases/published-forms:
     *   get:
     *     tags: [Cases]
     *     summary: Every form Oravanti publishes
     *     description: >
     *       What "add a form to this matter" chooses from. Read-only: the
     *       catalogue is maintained in Oravanti's CRM and no firm writes it.
     *     responses:
     *       200: { description: The catalogue }
     */
    this.router.get(
      "/published-forms",
      requirePermission("cases", "read"),
      this.workflowController.listPublishedForms,
    );

    /**
     * @openapi
     * /cases/{caseId}/field-map:
     *   get:
     *     tags: [Cases]
     *     summary: What fills each field, across this matter's forms
     *     description: >
     *       Read-only. The write that used to share this path decided the
     *       answer for every firm in the deployment and now lives in the CRM,
     *       under `requirePlatformAdmin`.
     *     responses:
     *       200: { description: Each form's fields and the question behind each }
     */
    this.router.get(
      "/:caseId/field-map",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getCaseFieldFeeds,
    );

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
     * /cases/{caseId}/forms/{formCode}/fields:
     *   get:
     *     tags: [Cases]
     *     summary: One form's contents
     *     description: >
     *       The form's field catalogue in its own order, each field with its
     *       value and where that value came from. Fields nothing has filled are
     *       included — an empty box on a form is information. A field a person
     *       edited by hand carries `isManualOverride`, and `conflictsWith` when
     *       the questionnaire has since come to say something different.
     *     responses:
     *       200: { description: Fields and completion }
     *       404: { description: Form not on this matter }
     */
    this.router.get(
      "/:caseId/forms/:formCode/fields",
      requirePermission("cases", "read"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.readCaseFormFields,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/fields/{fieldKey}:
     *   put:
     *     tags: [Cases]
     *     summary: Correct one field by hand
     *     description: >
     *       Marks the value as a manual override, which protects it from the
     *       next population run. What the questionnaire said is kept alongside,
     *       so a client changing their answer afterwards shows as a
     *       disagreement rather than silently reverting the correction.
     *     responses:
     *       200: { description: Saved }
     *       404: { description: No such field on this form }
     */
    this.router.put(
      "/:caseId/forms/:formCode/fields/:fieldKey",
      requirePermission("cases", "update"),
      validateRequest({ params: formFieldParam, body: setFormFieldBody }),
      this.workflowController.setCaseFormField,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/fields:
     *   put:
     *     tags: [Cases]
     *     summary: Save a whole form's corrections at once
     *     description: >
     *       The batch form of the call above, and the one the Forms tab uses:
     *       staff edit a form and press Save, so the request carries everything
     *       that changed. Each value is marked as a manual override exactly as
     *       a single-field save would. An unknown field key fails the whole
     *       batch rather than half-applying it.
     *     responses:
     *       200: { description: How many fields were saved }
     *       404: { description: Form not on this matter, or no such field }
     */
    this.router.put(
      "/:caseId/forms/:formCode/fields",
      requirePermission("cases", "update"),
      validateRequest({ params: formCodeParam, body: setFormFieldsBody }),
      this.workflowController.setCaseFormFields,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/populate:
     *   post:
     *     tags: [Cases]
     *     summary: Fill the matter's forms from its case questionnaire
     *     description: >
     *       Runs automatically when the case questionnaire is submitted; this
     *       is the same pass on demand, for when answers were edited afterwards.
     *       Safe to repeat — hand-edited fields are never overwritten unless
     *       `overrideManual` explicitly asks for it, and the response names the
     *       ones the questionnaire now disagrees with. `dryRun` reports what the
     *       pass would do and writes none of it.
     *     responses:
     *       200: { description: Counts of fields filled, updated, overridden and in conflict }
     */
    this.router.post(
      "/:caseId/forms/populate",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: populateFormsBody }),
      this.workflowController.populateCaseForms,
    );

    // ── The attorney's review of the filing package ─────────────────────────
    //
    // Registered before `/:caseId/forms/:formCode` would ever see them: these
    // paths are `/:caseId/filing-review` and `/:caseId/corrections`, so they
    // cannot collide, but they are kept together here because they are one
    // feature and reading them apart would hide the state machine.
    //
    // Every one is `cases:update` except the read. The attorney-only rules are
    // *not* expressed as a permission: "attorney" is a professional role, not a
    // permission grant, and the service is the only place that can answer it
    // for the batch path too. See `form-review.service.ts`.

    /**
     * @openapi
     * /cases/{caseId}/filing-review:
     *   get:
     *     tags: [Cases]
     *     summary: Where the filing package stands with the reviewing attorney
     *     description: >
     *       The review's state, who approved it, and every correction on the
     *       package with its thread. `canReview` says whether the caller may
     *       mark, approve and reopen — the tab renders from it rather than
     *       offering controls that would 403.
     *     responses:
     *       200: { description: The review }
     *       404: { description: Case not found }
     */
    this.router.get(
      "/:caseId/filing-review",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getFilingReview,
    );

    /**
     * @openapi
     * /cases/{caseId}/filing-review/request:
     *   post:
     *     tags: [Cases]
     *     summary: Send the package up for attorney review
     *     description: >
     *       What the team presses when the preparation work is done. Anyone on
     *       the matter may do it; it is idempotent.
     *     responses:
     *       200: { description: In review }
     */
    this.router.post(
      "/:caseId/filing-review/request",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.requestFilingReview,
    );

    /**
     * @openapi
     * /cases/{caseId}/filing-review/approve:
     *   post:
     *     tags: [Cases]
     *     summary: Approve the filing package
     *     description: >
     *       Attorney only, and refused while any correction is open — with the
     *       count in the message. Approval is what unlocks `ready_to_file` on
     *       the matter's forms, and the next correction raised spends it.
     *     responses:
     *       200: { description: Approved }
     *       403: { description: Not an attorney }
     *       409: { description: Corrections are still open }
     */
    this.router.post(
      "/:caseId/filing-review/approve",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.approveFilingReview,
    );

    /**
     * @openapi
     * /cases/{caseId}/corrections:
     *   post:
     *     tags: [Cases]
     *     summary: Mark a part or a field of a form for correction
     *     description: >
     *       Attorney only. Exactly one of `partLabel` and `fieldKey` anchors the
     *       mark; `note` says what is wrong and is required. Raising one puts
     *       the package into `changes_requested`.
     *     responses:
     *       201: { description: Raised }
     *       400: { description: Marked nothing, or marked both a part and a field }
     *       403: { description: Not an attorney }
     */
    this.router.post(
      "/:caseId/corrections",
      requirePermission("cases", "update"),
      validateRequest({ params: caseIdParams, body: raiseCorrectionBody }),
      this.workflowController.raiseFormCorrection,
    );

    /**
     * @openapi
     * /cases/{caseId}/corrections/{correctionId}/resolve:
     *   post:
     *     tags: [Cases]
     *     summary: Answer a correction and close it
     *     description: >
     *       For whoever did the work — the note saying what they changed is
     *       required and joins the mark's thread. The attorney reads it on
     *       their next pass and can reopen.
     *     responses:
     *       200: { description: Resolved }
     *       409: { description: Already resolved }
     */
    this.router.post(
      "/:caseId/corrections/:correctionId/resolve",
      requirePermission("cases", "update"),
      validateRequest({ params: correctionParam, body: correctionNoteBody }),
      this.workflowController.resolveFormCorrection,
    );

    /**
     * @openapi
     * /cases/{caseId}/corrections/{correctionId}/reopen:
     *   post:
     *     tags: [Cases]
     *     summary: Reopen a correction the fix did not answer
     *     description: >
     *       Attorney only. Puts the package back into `changes_requested` and
     *       clears any approval — a sign-off cannot survive the thing it signed
     *       off being wrong again.
     *     responses:
     *       200: { description: Reopened }
     *       409: { description: Already open }
     */
    this.router.post(
      "/:caseId/corrections/:correctionId/reopen",
      requirePermission("cases", "update"),
      validateRequest({ params: correctionParam, body: correctionNoteBody }),
      this.workflowController.reopenFormCorrection,
    );

    /**
     * @openapi
     * /cases/{caseId}/corrections/{correctionId}/comments:
     *   post:
     *     tags: [Cases]
     *     summary: Add to a correction's thread without closing it
     *     responses:
     *       201: { description: Added }
     */
    this.router.post(
      "/:caseId/corrections/:correctionId/comments",
      requirePermission("cases", "update"),
      validateRequest({ params: correctionParam, body: correctionCommentBody }),
      this.workflowController.commentOnFormCorrection,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions:
     *   get:
     *     tags: [Cases]
     *     summary: One form's save history
     *     description: >
     *       Every save against this form, newest first, each saying who made it
     *       and how many fields moved. `actor` separates a person typing on the
     *       form from a population run carrying answers across — which is the
     *       first question anyone asks of a form that turns out to be wrong.
     *     responses:
     *       200: { description: Versions }
     *       404: { description: Form not on this matter }
     */
    this.router.get(
      "/:caseId/forms/:formCode/versions",
      requirePermission("cases", "read"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.listFormVersions,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions/{versionId}:
     *   get:
     *     tags: [Cases]
     *     summary: One save, and the fields it changed
     *     responses:
     *       200: { description: The snapshot and its changes }
     *       404: { description: No such version }
     */
    this.router.get(
      "/:caseId/forms/:formCode/versions/:versionId",
      requirePermission("cases", "read"),
      validateRequest({ params: formVersionParam }),
      this.workflowController.getFormVersion,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions/{versionId}/restore:
     *   post:
     *     tags: [Cases]
     *     summary: Put the form back to an earlier save
     *     description: >
     *       A POST because it *writes a new version* rather than rewinding to an
     *       old one — nothing after the restored version is erased, which is
     *       what makes restoring safe to try. Fields the catalogue has since
     *       dropped are left out, and fields added since are cleared.
     *     responses:
     *       200: { description: Restored, as a new version }
     */
    this.router.post(
      "/:caseId/forms/:formCode/versions/:versionId/restore",
      requirePermission("cases", "update"),
      validateRequest({ params: formVersionParam }),
      this.workflowController.restoreFormVersion,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/fields/{fieldKey}/history:
     *   get:
     *     tags: [Cases]
     *     summary: One field's timeline
     *     description: >
     *       Scoped to this form as well as the key, so a key printed on six
     *       forms of a package — every name and date is — shows only this
     *       form's history.
     *     responses:
     *       200: { description: Revisions, newest first }
     */
    this.router.get(
      "/:caseId/forms/:formCode/fields/:fieldKey/history",
      requirePermission("cases", "read"),
      validateRequest({ params: formFieldParam }),
      this.workflowController.getFieldHistory,
    );

    /**
     * @openapi
     * /cases/{caseId}/form-revisions/{revisionId}/restore:
     *   post:
     *     tags: [Cases]
     *     summary: Put one field back to what a revision recorded
     *     description: >
     *       Forward, like a version restore: the field is written again as a
     *       manual edit, and the save that does it is itself a new version.
     *     responses:
     *       200: { description: Restored }
     */
    this.router.post(
      "/:caseId/form-revisions/:revisionId/restore",
      requirePermission("cases", "update"),
      validateRequest({ params: formRevisionParam }),
      this.workflowController.restoreFieldRevision,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions:
     *   get:
     *     tags: [Cases]
     *     summary: The saves made against one form
     *     description: >
     *       Newest first, each naming who saved it and how many fields moved.
     *       A save by a population run is attributed to the questionnaire
     *       rather than to a person, because no one person performed it.
     *     responses:
     *       200: { description: Versions, newest first }
     *       404: { description: Form not on this matter }
     */
    this.router.get(
      "/:caseId/forms/:formCode/versions",
      requirePermission("cases", "read"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.listFormVersions,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions/{versionId}:
     *   get:
     *     tags: [Cases]
     *     summary: One version, with what it changed
     *     responses:
     *       200: { description: The snapshot and its field changes }
     *       404: { description: Version not found }
     */
    this.router.get(
      "/:caseId/forms/:formCode/versions/:versionId",
      requirePermission("cases", "read"),
      validateRequest({ params: formVersionParam }),
      this.workflowController.getFormVersion,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/fields/{fieldKey}/history:
     *   get:
     *     tags: [Cases]
     *     summary: One field's timeline
     *     description: >
     *       Every value that box has held on this form, newest first, with
     *       where each came from. Scoped to the form as well as the key, so a
     *       key that appears on six forms of a package shows only this one.
     *     responses:
     *       200: { description: Revisions, newest first }
     */
    this.router.get(
      "/:caseId/forms/:formCode/fields/:fieldKey/history",
      requirePermission("cases", "read"),
      validateRequest({ params: formFieldParam }),
      this.workflowController.getFieldHistory,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/versions/{versionId}/restore:
     *   post:
     *     tags: [Cases]
     *     summary: Put a form back to an earlier version
     *     description: >
     *       A POST rather than a PUT because it *writes a new version* — the
     *       state you are leaving stays as version N and the restore is N+1.
     *       Nothing after the restored version is erased, which is what makes
     *       restoring safe to try. Fields the catalogue has since dropped are
     *       left out.
     *     responses:
     *       200: { description: How many fields the restore changed }
     *       404: { description: Version not found }
     */
    this.router.post(
      "/:caseId/forms/:formCode/versions/:versionId/restore",
      requirePermission("cases", "update"),
      validateRequest({ params: formVersionParam }),
      this.workflowController.restoreFormVersion,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/revisions/{revisionId}/restore:
     *   post:
     *     tags: [Cases]
     *     summary: Put one field back to what a revision recorded
     *     description: >
     *       The single-field form of the call above, and a new version in the
     *       same way. Not keyed by form code: a revision already knows which
     *       form it belongs to.
     *     responses:
     *       200: { description: Restored }
     *       404: { description: Revision not found }
     */
    this.router.post(
      "/:caseId/forms/revisions/:revisionId/restore",
      requirePermission("cases", "update"),
      validateRequest({ params: formRevisionParam }),
      this.workflowController.restoreFieldRevision,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/package/pdf:
     *   get:
     *     tags: [Cases]
     *     summary: The matter every form, merged into one PDF in package order
     *     description: >
     *       Fills each form on the matter and concatenates them in the order
     *       the case type filing package declares, so the paper comes out in
     *       the sequence it is filed in. `X-Forms-Included` lists what is in
     *       it and `X-Forms-Failed` names any form that could not be rendered
     *       — a package short of a form is a fact the caller has to see.
     *     responses:
     *       200:
     *         description: The merged PDF
     *         content:
     *           application/pdf: {}
     */
    // Registered before `/:caseId/forms/:formCode/pdf`, which would otherwise
    // match "package" as a form code and 400 on the pattern.
    this.router.get(
      "/:caseId/forms/package/pdf",
      requirePermission("cases", "read"),
      validateRequest({ params: caseIdParams }),
      this.workflowController.getCasePackagePdf,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/pdf:
     *   get:
     *     tags: [Cases]
     *     summary: The matter's copy of a form as a filled PDF
     *     description: >
     *       Fills the official blank for the form's current edition with this
     *       matter's answers and streams it inline. `X-Fields-Written` and
     *       `X-Fields-Skipped` report how much of the form was populated.
     *     responses:
     *       200:
     *         description: The filled PDF
     *         content:
     *           application/pdf: {}
     */
    this.router.get(
      "/:caseId/forms/:formCode/pdf",
      requirePermission("cases", "read"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.getCaseFormPdf,
    );

    /**
     * @openapi
     * /cases/{caseId}/forms/{formCode}/boxes:
     *   get:
     *     tags: [Cases]
     *     summary: Where each of the form's data prints on the page
     *     description: >
     *       Rectangles in percentages of the page, so the Forms tab can draw
     *       the reviewing attorney's marks over the rendered PDF and let one be
     *       placed by pointing at the box. A datum printing into more than one
     *       box carries all of them.
     */
    this.router.get(
      "/:caseId/forms/:formCode/boxes",
      requirePermission("cases", "read"),
      validateRequest({ params: formCodeParam }),
      this.workflowController.getCaseFormBoxes,
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
      validateRequest({
        params: caseIdParams,
        body: upsertPersonalInjuryDetailsBody,
      }),
      this.workflowController.upsertPersonalInjuryDetails,
    );
  }
}
