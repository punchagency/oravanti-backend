import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  leadDocumentLinks,
  leadTasks,
  leadTimelineEvents,
  leads,
} from "../../db/schema";
import type { LeadEventType } from "../../db/schema/leads";
import { logLeadEvent } from "./lead-events.service";
import { documents, documentVersions } from "../../db/schema/documents";
import { staff } from "../../db/schema/staff";
import {
  BadRequestError,
  NotFoundError,
} from "../../utils/error/app-error";

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
    const [task] = await db
      .insert(leadTasks)
      .values({ ...data, organizationId })
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: data.leadId,
      type: "task_created" as LeadEventType,
      actorId,
      metadata: { taskId: task.id, title: data.title, pipelineStage: data.pipelineStage },
    });

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
      type: "task_updated" as LeadEventType,
      actorId,
      metadata: { taskId, title: task.title, changes: data },
    });

    return task;
  }

  async assignTask(
    taskId: string,
    assignedToId: string,
    organizationId: string,
    actorId?: string | null,
  ) {
    const existing = await this.getTask(taskId, organizationId);
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
      .where(eq(staff.id, assignedToId))
      .limit(1);

    await logLeadEvent({
      organizationId,
      leadId: existing.leadId,
      type: "task_assigned" as LeadEventType,
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
      type: "task_completed" as LeadEventType,
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
      type: "task_status_changed" as LeadEventType,
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
      type: "task_deleted" as LeadEventType,
      actorId,
      metadata: { taskId, title: existing.title, pipelineStage: existing.pipelineStage },
    });
  }

  async submitTaskForReview(
    taskId: string,
    submittedById: string,
    notes: string | undefined,
    organizationId: string,
  ) {
    const task = await this.getTask(taskId, organizationId);
    if (task.status !== "in_progress") {
      throw new BadRequestError("Only in-progress tasks can be submitted for review");
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "in_review",
        completedById: submittedById,
        completedAt: new Date(),
        notes: notes ?? task.notes,
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      type: "task_submitted_for_review" as LeadEventType,
      actorId: submittedById,
      metadata: { taskId, title: task.title, note: notes },
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
      throw new BadRequestError("Only tasks in review can be approved");
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "completed",
        completedById: approverId,
        completedAt: new Date(),
        notes: notes ?? task.notes,
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      type: "task_approved" as LeadEventType,
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
      throw new BadRequestError("Only tasks in review can be rejected");
    }
    const [updated] = await db
      .update(leadTasks)
      .set({
        status: "in_progress",
        completedById: null,
        completedAt: null,
        notes: feedback,
        updatedAt: new Date(),
      })
      .where(
        and(eq(leadTasks.id, taskId), eq(leadTasks.organizationId, organizationId)),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId: task.leadId,
      type: "task_rejected" as LeadEventType,
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
    const statuses = (status
      ? status.split(",").filter(Boolean)
      : ["in_review", "completed"]) as ("pending" | "in_progress" | "in_review" | "completed" | "skipped")[];
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

  async initializePipelineSteps(leadId: string, organizationId: string, assignedToId?: string) {
    const existing = await db
      .select()
      .from(leadTasks)
      .where(
        and(eq(leadTasks.leadId, leadId), eq(leadTasks.organizationId, organizationId)),
      )
      .orderBy(asc(leadTasks.orderIndex));
    if (existing.length > 0) return existing;

    const defaultTasks = [
      {
        leadId, organizationId, assignedToId,
        title: "Run conflict check",
        description: "Check for conflicts of interest with existing clients and adverse parties",
        orderIndex: 0, pipelineStage: "conflict_check" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Review conflict results",
        description: "Analyze conflict check results and determine next steps",
        orderIndex: 1, pipelineStage: "conflict_check" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Send intake questionnaire",
        description: "Send the intake questionnaire to the lead for detailed information",
        orderIndex: 0, pipelineStage: "questionnaire" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Review questionnaire responses",
        description: "Review and analyze the completed intake questionnaire",
        orderIndex: 1, pipelineStage: "questionnaire" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Schedule consultation",
        description: "Book initial consultation with the lead",
        orderIndex: 0, pipelineStage: "consultation" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Conduct consultation",
        description: "Hold the initial consultation meeting",
        orderIndex: 1, pipelineStage: "consultation" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Prepare fee agreement",
        description: "Draft the fee agreement for the lead",
        orderIndex: 0, pipelineStage: "fee_agreement" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Send fee agreement",
        description: "Send fee agreement to lead for signature",
        orderIndex: 1, pipelineStage: "fee_agreement" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Receive signed fee agreement",
        description: "Confirm receipt of the signed fee agreement",
        orderIndex: 2, pipelineStage: "fee_agreement" as const,
      },
      {
        leadId, organizationId, assignedToId,
        title: "Open case file",
        description: "Convert lead to active case and create case file",
        orderIndex: 0, pipelineStage: "case_opening" as const,
      },
    ];

    const steps = await db.insert(leadTasks).values(defaultTasks).returning();

    await logLeadEvent({
      organizationId,
      leadId,
      type: "pipeline_initialized",
      metadata: { taskCount: steps.length },
    });

    return steps;
  }

  // ─── Timeline Events ────────────────────────────────────────────────────────

  async getTimelineEvents(leadId: string, organizationId: string) {
    return db
      .select()
      .from(leadTimelineEvents)
      .leftJoin(staff, eq(leadTimelineEvents.createdById, staff.id))
      .innerJoin(leads, eq(leadTimelineEvents.leadId, leads.id))
      .where(
        and(
          eq(leadTimelineEvents.leadId, leadId),
          eq(leads.organizationId, organizationId),
        ),
      )
      .orderBy(asc(leadTimelineEvents.createdAt));
  }

  async createTimelineEvent(
    data: {
      leadId: string;
      eventType: string;
      title: string;
      description?: string;
      metadata?: Record<string, unknown>;
      createdById?: string;
    },
  ) {
    const [event] = await db
      .insert(leadTimelineEvents)
      .values(data)
      .returning();
    return event;
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
      })
      .from(leadDocumentLinks)
      .innerJoin(documents, eq(leadDocumentLinks.documentId, documents.id))
      .innerJoin(leads, eq(leadDocumentLinks.leadId, leads.id))
      .leftJoin(
        documentVersions,
        eq(documents.currentVersionId, documentVersions.id),
      )
      .where(
        and(eq(leadDocumentLinks.leadId, leadId), eq(leads.organizationId, organizationId)),
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
        type: "document_linked" as LeadEventType,
        actorId: linkedByStaffId,
        metadata: { documentId, linkId: link.id },
      });
    }

    return link;
  }

  async unlinkDocument(linkId: string, leadId: string, organizationId?: string) {
    const [existing] = await db
      .select()
      .from(leadDocumentLinks)
      .where(
        and(eq(leadDocumentLinks.id, linkId), eq(leadDocumentLinks.leadId, leadId)),
      );

    await db
      .delete(leadDocumentLinks)
      .where(
        and(eq(leadDocumentLinks.id, linkId), eq(leadDocumentLinks.leadId, leadId)),
      );

    if (organizationId && existing) {
      await logLeadEvent({
        organizationId,
        leadId,
        type: "document_unlinked" as LeadEventType,
        metadata: { documentId: existing.documentId, linkId },
      });
    }
  }
}
