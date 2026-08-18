import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { createModuleLogger } from "../../lib/logging/log";
import {
  leadDocumentLinks,
  leadTasks,
  leads,
} from "../../db/schema";
import { assertAssignableStaff } from "../../utils/assignable-staff";
import { triggerScenarioScan } from "../ai-scan/scan-triggers";
import { recordTaskReviewEvent } from "../shared/task-review-events.service";
import { resolveIntakePipelineSteps } from "./intake-pipeline-template.service";
import { logLeadEvent } from "./lead-events.service";
import { documents, documentVersions } from "../../db/schema/documents";
import { staff } from "../../db/schema/staff";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/error/app-error";

const log = createModuleLogger("lead-workflow.service");

export class LeadWorkflowService {
  // ─── Lead Tasks ────────────────────────────────────────────────────────────

  async getTasks(leadId: string, organizationId: string) {
    return db
      .select({
        id: leadTasks.id,
        organizationId: leadTasks.organizationId,
        leadId: leadTasks.leadId,
        title: leadTasks.title,
        description: leadTasks.description,
        orderIndex: leadTasks.orderIndex,
        pipelineStage: leadTasks.pipelineStage,
        isRequired: leadTasks.isRequired,
        status: leadTasks.status,
        assignedToId: leadTasks.assignedToId,
        assignedAt: leadTasks.assignedAt,
        completedById: leadTasks.completedById,
        completedAt: leadTasks.completedAt,
        dueDate: leadTasks.dueDate,
        notes: leadTasks.notes,
        createdAt: leadTasks.createdAt,
        updatedAt: leadTasks.updatedAt,
        staff: {
          id: staff.id,
          name: sql`concat(${staff.firstName}, ' ', ${staff.lastName})`,
          role: staff.role,
        },
        lead: {
          name: sql`concat(${leads.firstName}, ' ', ${leads.lastName})`,
          email: leads.email,
          pipelineStage: leads.pipelineStage,
        },
      })
      .from(leadTasks)
      .leftJoin(staff, eq(leadTasks.assignedToId, staff.id))
      .innerJoin(leads, eq(leadTasks.leadId, leads.id))
      .where(
        and(
          eq(leadTasks.leadId, leadId),
          eq(leadTasks.organizationId, organizationId),
        ),
      )
      .orderBy(asc(leadTasks.orderIndex));
  }

  async getMyTasks(staffId: string, organizationId: string) {
    return db
      .select({
        id: leadTasks.id,
        organizationId: leadTasks.organizationId,
        leadId: leadTasks.leadId,
        title: leadTasks.title,
        description: leadTasks.description,
        orderIndex: leadTasks.orderIndex,
        pipelineStage: leadTasks.pipelineStage,
        isRequired: leadTasks.isRequired,
        status: leadTasks.status,
        assignedToId: leadTasks.assignedToId,
        assignedAt: leadTasks.assignedAt,
        completedById: leadTasks.completedById,
        completedAt: leadTasks.completedAt,
        dueDate: leadTasks.dueDate,
        notes: leadTasks.notes,
        createdAt: leadTasks.createdAt,
        updatedAt: leadTasks.updatedAt,
        lead: {
          id: leads.id,
          name: sql`concat(${leads.firstName}, ' ', ${leads.lastName})`,
          email: leads.email,
          pipelineStage: leads.pipelineStage,
        },
      })
      .from(leadTasks)
      .innerJoin(leads, eq(leadTasks.leadId, leads.id))
      .where(
        and(
          eq(leadTasks.assignedToId, staffId),
          eq(leadTasks.organizationId, organizationId),
        ),
      )
      .orderBy(asc(leadTasks.pipelineStage), asc(leadTasks.orderIndex));
  }

  async getTask(taskId: string, organizationId: string) {
    const [task] = await db
      .select()
      .from(leadTasks)
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      );
    if (!task) throw new NotFoundError("Lead task not found");
    return task;
  }

  async createTask(
    data: {
      leadId: string;
      title: string;
      description?: string;
      orderIndex: number;
      pipelineStage: "conflict_check" | "questionnaire" | "consultation" | "fee_agreement" | "case_opening";
      isRequired?: boolean;
      assignedToId?: string;
      dueDate?: string;
    },
    organizationId: string,
    actorId?: string | null,
  ) {
    if (data.assignedToId) {
      await assertAssignableStaff(data.assignedToId, organizationId);
    }

    const [task] = await db
      .insert(leadTasks)
      .values({ ...data, organizationId })
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: data.leadId,
      action: "lead.task_created",
      actorId,
      metadata: { taskId: task.id, title: data.title, pipelineStage: data.pipelineStage },
    });

    log.action("lead_workflow.created", { taskId: task.id, leadId: data.leadId });

    return task;
  }

  async updateTask(
    taskId: string,
    data: {
      title?: string;
      description?: string;
      orderIndex?: number;
      isRequired?: boolean;
      dueDate?: string;
      notes?: string;
    },
    organizationId: string,
    actorId?: string | null,
  ) {
    const existing = await this.getTask(taskId, organizationId);
    const [task] = await db
      .update(leadTasks)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      action: "lead.task_updated",
      actorId,
      metadata: { taskId, title: task.title, changes: data },
    });

    log.action("lead_workflow.updated", { taskId, leadId: existing.leadId });

    return task;
  }

  async assignTask(
    taskId: string,
    assignedToId: string,
    organizationId: string,
    actorId?: string | null,
  ) {
    const existing = await this.getTask(taskId, organizationId);
    await assertAssignableStaff(assignedToId, organizationId);

    const [task] = await db
      .update(leadTasks)
      .set({
        assignedToId,
        assignedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    const [assignee] = await db
      .select({ name: sql<string>`concat(${staff.firstName}, ' ', ${staff.lastName})` })
      .from(staff)
      .where(
        and(
          eq(staff.id, assignedToId),
          eq(staff.organizationId, organizationId),
        ),
      )
      .limit(1);

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      action: "lead.task_assigned",
      actorId,
      metadata: { taskId, title: existing.title, assignedToId, assigneeName: assignee?.name },
    });

    return task;
  }

  async completeTask(
    taskId: string,
    completedById: string,
    organizationId: string,
  ) {
    const existing = await this.getTask(taskId, organizationId);
    const [task] = await db
      .update(leadTasks)
      .set({
        status: "completed",
        completedById,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      action: "lead.task_completed",
      actorId: completedById,
      metadata: { taskId, title: existing.title },
    });

    return task;
  }

  async updateTaskStatus(
    taskId: string,
    status: "pending" | "in_progress" | "in_review" | "completed" | "skipped",
    organizationId: string,
    actorId?: string | null,
  ) {
    const existing = await this.getTask(taskId, organizationId);
    const updateData: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === "completed") {
      updateData.completedAt = new Date();
    }
    const [task] = await db
      .update(leadTasks)
      .set(updateData)
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      action: "lead.task_status_changed",
      actorId,
      metadata: { taskId, title: existing.title, from: existing.status, to: status },
    });

    return task;
  }

  async deleteTask(taskId: string, organizationId: string, actorId?: string | null) {
    const existing = await this.getTask(taskId, organizationId);
    await db
      .delete(leadTasks)
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      );

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      action: "lead.task_deleted",
      actorId,
      metadata: { taskId, title: existing.title, pipelineStage: existing.pipelineStage },
    });

    log.action("lead_workflow.deleted", { taskId, leadId: existing.leadId });
  }

  async submitTaskForReview(
    taskId: string,
    submittedById: string,
    notes: string | undefined,
    organizationId: string,
  ) {
    const task = await this.getTask(taskId, organizationId);
    // A rejected task is resubmitted straight from here rather than forcing a
    // separate "reopen" round trip.
    if (task.status !== "in_progress" && task.status !== "rejected") {
      log.warn("lead_workflow.submission_rejected", { taskId, status: task.status });
      throw new BadRequestError(
        "Only in-progress or rejected tasks can be submitted for review",
      );
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "in_review",
        completedById: submittedById,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "lead_task",
      taskId,
      leadId: task.leadId,
      action: "task.submitted",
      note: notes,
      actorId: submittedById,
    });

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      action: "lead.task_submitted_for_review",
      actorId: submittedById,
      metadata: { taskId, title: task.title, note: notes },
    });

    return updated;
  }

  /**
   * Puts a rejected task back into the assignee's hands.
   *
   * Rejection is terminal until someone acts on the feedback, so returning to
   * `in_progress` is an explicit step rather than something the reviewer does
   * on the assignee's behalf.
   */
  async reopenTask(
    taskId: string,
    actorId: string,
    notes: string | undefined,
    organizationId: string,
  ) {
    const task = await this.getTask(taskId, organizationId);
    if (task.status !== "rejected") {
      log.warn("lead_workflow.reopen_rejected", { taskId, status: task.status });
      throw new BadRequestError("Only rejected tasks can be reopened");
    }

    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "in_progress",
        completedById: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "lead_task",
      taskId,
      leadId: task.leadId,
      action: "task.reopened",
      note: notes,
      actorId,
    });

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      action: "lead.task_status_changed",
      actorId,
      metadata: { taskId, title: task.title, from: "rejected", to: "in_progress" },
    });

    return updated;
  }

  async approveTask(
    taskId: string,
    approverId: string,
    notes: string | undefined,
    organizationId: string,
  ) {
    const task = await this.getTask(taskId, organizationId);
    if (task.status !== "in_review") {
      log.warn("lead_workflow.approve_rejected", { taskId, status: task.status });
      throw new BadRequestError("Only tasks in review can be approved");
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "completed",
        completedById: approverId,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "lead_task",
      taskId,
      leadId: task.leadId,
      action: "task.approved",
      note: notes,
      actorId: approverId,
    });

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      action: "lead.task_approved",
      actorId: approverId,
      metadata: { taskId, title: task.title, note: notes },
    });

    return updated;
  }

  async rejectTask(
    taskId: string,
    reviewerId: string,
    feedback: string,
    organizationId: string,
  ) {
    const task = await this.getTask(taskId, organizationId);
    if (task.status !== "in_review") {
      log.warn("lead_workflow.reject_rejected", { taskId, status: task.status });
      throw new BadRequestError("Only tasks in review can be rejected");
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        // Terminal until the assignee reopens it: dropping straight back to
        // `in_progress` gave them no signal that anything had been rejected.
        status: "rejected",
        completedById: null,
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "lead_task",
      taskId,
      leadId: task.leadId,
      action: "task.rejected",
      note: feedback,
      actorId: reviewerId,
    });

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      action: "lead.task_rejected",
      actorId: reviewerId,
      metadata: { taskId, title: task.title, feedback },
    });

    return updated;
  }

  async getReviewQueue(
    organizationId: string,
    status?: string,
    page = 1,
    limit = 20,
  ) {
    // `rejected` is in the default set so a reviewer can still see what they
    // sent back — it leaves the queue only once the assignee resubmits.
    const statuses = (status
      ? status.split(",").filter(Boolean)
      : ["in_review", "rejected", "completed"]) as (
      | "pending"
      | "in_progress"
      | "in_review"
      | "completed"
      | "skipped"
      | "rejected"
    )[];
    const offset = (page - 1) * limit;

    const [items, [{ total }]] = await Promise.all([
      db
        .select({
          id: leadTasks.id,
          title: leadTasks.title,
          description: leadTasks.description,
          status: leadTasks.status,
          pipelineStage: leadTasks.pipelineStage,
          orderIndex: leadTasks.orderIndex,
          leadId: leadTasks.leadId,
          assignedToId: leadTasks.assignedToId,
          assignedToName: sql<string | null>`concat(${staff.firstName}, ' ', ${staff.lastName})`,
          completedAt: leadTasks.completedAt,
          completedById: leadTasks.completedById,
          notes: leadTasks.notes,
          dueDate: leadTasks.dueDate,
          leadName: sql`concat(${leads.firstName}, ' ', ${leads.lastName})`,
          leadEmail: leads.email,
          createdAt: leadTasks.createdAt,
          updatedAt: leadTasks.updatedAt,
        })
        .from(leadTasks)
        .leftJoin(staff, eq(leadTasks.assignedToId, staff.id))
        .innerJoin(leads, eq(leadTasks.leadId, leads.id))
        .where(
          and(
            eq(leadTasks.organizationId, organizationId),
            inArray(leadTasks.status, statuses),
          ),
        )
        .orderBy(desc(leadTasks.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(leadTasks)
        .where(
          and(
            eq(leadTasks.organizationId, organizationId),
            inArray(leadTasks.status, statuses),
          ),
        ),
    ]);

    return { items, pagination: { total, limit, offset } };
  }

  /**
   * Stamps the firm's intake checklist onto a lead.
   *
   * The steps come from `intake_pipeline_templates` — the firm's own active
   * template if it has one, otherwise the system default — so changing the
   * checklist is a data edit rather than a deploy. If nothing has been seeded
   * the system default is created on demand, which stops a fresh database from
   * silently producing leads with no pipeline at all.
   */
  async initializePipelineSteps(leadId: string, organizationId: string, assignedToId?: string) {
    const existing = await db
      .select()
      .from(leadTasks)
      .where(
        and(eq(leadTasks.leadId, leadId), eq(leadTasks.organizationId, organizationId)),
      )
      .orderBy(asc(leadTasks.orderIndex));
    if (existing.length > 0) return existing;

    const templateSteps = await resolveIntakePipelineSteps(organizationId);

    const steps = await db
      .insert(leadTasks)
      .values(
        templateSteps.map((step) => ({
          leadId,
          organizationId,
          assignedToId,
          title: step.title,
          description: step.description,
          orderIndex: step.orderIndex,
          pipelineStage: step.pipelineStage,
          isRequired: step.isRequired,
        })),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId,
      action: "lead.pipeline_initialized",
      metadata: { taskCount: steps.length },
    });

    return steps;
  }

  // ─── Document Links ─────────────────────────────────────────────────────────

  async getLinkedDocuments(leadId: string, organizationId: string) {
    return db
      .select({
        id: leadDocumentLinks.id,
        documentId: leadDocumentLinks.documentId,
        leadId: leadDocumentLinks.leadId,
        linkedByStaffId: leadDocumentLinks.linkedByStaffId,
        archivedAt: leadDocumentLinks.archivedAt,
        createdAt: leadDocumentLinks.createdAt,
        updatedAt: leadDocumentLinks.updatedAt,
        title: documents.title,
        status: documents.status,
        category: documents.category,
        originalFileName: documentVersions.originalFileName,
        mimeType: documentVersions.mimeType,
        fileSize: documentVersions.fileSize,
        versionNumber: documentVersions.versionNumber,
        // Two independent axes: malware vs. AI document review.
        virusScanStatus: documentVersions.virusScanStatus,
        aiScanStatus: documentVersions.aiScanStatus,
      })
      .from(leadDocumentLinks)
      .innerJoin(documents, eq(leadDocumentLinks.documentId, documents.id))
      .innerJoin(leads, eq(leadDocumentLinks.leadId, leads.id))
      .leftJoin(
        documentVersions,
        eq(documents.currentVersionId, documentVersions.id),
      )
      .where(
        and(
          eq(leadDocumentLinks.leadId, leadId),
          eq(leads.organizationId, organizationId),
          // Unlinked documents keep their row for audit; don't surface them.
          isNull(leadDocumentLinks.archivedAt),
        ),
      );
  }

  async linkDocument(
    documentId: string,
    leadId: string,
    linkedByStaffId?: string,
    organizationId?: string,
  ) {
    const [link] = await db
      .insert(leadDocumentLinks)
      .values({ documentId, leadId, linkedByStaffId })
      .returning();

    if (organizationId) {
      await logLeadEvent({
        organizationId,
        leadId,
        action: "lead.document_linked",
        actorId: linkedByStaffId,
        metadata: { documentId, linkId: link.id },
      });

      // A newly-linked document is now in the lead's scan set.
      triggerScenarioScan({
        organizationId,
        scenarioType: "lead",
        scenarioId: leadId,
        trigger: "upload",
        requestedByStaffId: linkedByStaffId,
      });
    }

    return link;
  }

  async unlinkDocument(linkId: string, leadId: string, organizationId: string) {
    const [existing] = await db
      .select({ id: leadDocumentLinks.id, documentId: leadDocumentLinks.documentId })
      .from(leadDocumentLinks)
      .innerJoin(leads, eq(leadDocumentLinks.leadId, leads.id))
      .where(
        and(eq(leadDocumentLinks.id, linkId), eq(leadDocumentLinks.leadId, leadId), eq(leads.organizationId, organizationId)),
      );

    await db
      .delete(leadDocumentLinks)
      .where(
        and(
          eq(leadDocumentLinks.id, linkId),
          inArray(leadDocumentLinks.leadId, db.select({ id: leads.id }).from(leads).where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))),
        ),
      );

    if (organizationId && existing) {
      await logLeadEvent({
        organizationId,
        leadId,
        action: "lead.document_unlinked",
        metadata: { documentId: existing.documentId, linkId },
      });
    }
  }
}
