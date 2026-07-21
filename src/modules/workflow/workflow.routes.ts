/**
 * @openapi
 * tags:
 *   - name: Workflow
 *     description: Workflow automation engine
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { WorkflowController } from "./workflow.controller";

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
    /**
     * @openapi
     * /cases/workflow/my-tasks:
     *   get:
     *     tags: [Workflow]
     *     summary: Get workflow steps assigned to the current staff member
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: List of assigned tasks
     */
    this.router.get(
      "/workflow/my-tasks",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.workflowController.getMyTasks,
    );

    /**
     * @openapi
     * /cases/workflow/review-queue:
     *   get:
     *     tags: [Workflow]
     *     summary: Get all steps awaiting review across all cases
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200:
     *         description: List of steps in review
     */
    this.router.get(
      "/workflow/review-queue",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.workflowController.getReviewQueue,
    );

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
      requireAdmin,
      setFirmContext,
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
      requireAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.completeStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/submit-review:
     *   post:
     *     tags: [Workflow]
     *     summary: Submit a step for review (in_progress → in_review)
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
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.submitForReview,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/approve:
     *   post:
     *     tags: [Workflow]
     *     summary: Approve a step (in_review → completed)
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
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.approveStep,
    );

    /**
     * @openapi
     * /cases/{caseId}/workflow/steps/{stepId}/reject:
     *   post:
     *     tags: [Workflow]
     *     summary: Reject a step with feedback (in_review → in_progress)
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
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId", "stepId") }),
      this.workflowController.rejectStep,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireAdmin,
      setFirmContext,
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
      requireAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getLogs,
    );

    // ── Case Notes ──────────────────────────────────────────────────────────────

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
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
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
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: this.validation.params("caseId"),
        body: this.validation.requiredBody("noteIds", "isPinned"),
      }),
      this.workflowController.bulkPinNotes,
    );

    // ── Case Audit Log ──────────────────────────────────────────────────────────

    /**
     * @openapi
     * /cases/{caseId}/audit-log:
     *   get:
     *     tags: [Workflow]
     *     summary: Get case audit log (case events)
     *     security: [{ bearerAuth: [] }]
     *     parameters:
     *       - in: path
     *         name: caseId
     *         required: true
     *         schema: { type: string }
     *       - in: query
     *         name: page
     *         schema: { type: integer }
     *       - in: query
     *         name: limit
     *         schema: { type: integer }
     *     responses:
     *       200:
     *         description: Paginated audit log entries
     */
    this.router.get(
      "/:caseId/audit-log",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ params: this.validation.params("caseId") }),
      this.workflowController.getAuditLog,
    );
  }
}
