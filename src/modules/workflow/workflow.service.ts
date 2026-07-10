import { and, asc, count, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { stepActionLogs } from "../../db/schema";
import { cases } from "../../db/schema/cases";
import { leaveRequests } from "../../db/schema/leave-requests";
import { staff } from "../../db/schema/staff";
import { certifications } from "../../db/schema/cases";
import { staffCertifications } from "../../db/schema/staff-certifications";
import {
  caseNotes,
  caseTimelineEvents,
  caseWorkflowSteps,
  workflowLog,
  workflowModules,
  workflowTemplateSteps,
  workflowTemplates,
} from "../../db/schema/workflow";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export class WorkflowService {
  // ─── Get workflow for a case (read-only) ────────────────────────────────────────

  async getWorkflow(caseId: string, organizationId: string) {
    await this.getCase(caseId, organizationId);

    const existingSteps = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .orderBy(asc(caseWorkflowSteps.orderIndex));

    if (existingSteps.length > 0) {
      return this.buildWorkflowResponse(caseId, organizationId);
    }

    return { caseId, modules: [], startedAt: null };
  }

  // ─── Hydrate: copy template → case instances ────────────────────────────────────

  // ─── Get workflow response ──────────────────────────────────────────────────────

  private async buildWorkflowResponse(caseId: string, organizationId: string) {
    const modules = await db
      .select()
      .from(workflowModules)
      .innerJoin(
        workflowTemplateSteps,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .innerJoin(
        caseWorkflowSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .orderBy(
        asc(workflowModules.orderIndex),
        asc(workflowTemplateSteps.orderIndex),
      );

    if (modules.length === 0) {
      return { caseId, modules: [], startedAt: null };
    }

    const stepStaffIds = new Set<string>();
    for (const row of modules) {
      if (row.case_workflow_steps.assignedToId)
        stepStaffIds.add(row.case_workflow_steps.assignedToId);
      if (row.case_workflow_steps.completedById)
        stepStaffIds.add(row.case_workflow_steps.completedById);
    }

    const staffMap = new Map<
      string,
      { id: string; name: string; role: string }
    >();
    if (stepStaffIds.size > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, [...stepStaffIds]));
      for (const s of staffRows) {
        staffMap.set(s.id, {
          id: s.id,
          name: `${s.firstName} ${s.lastName}`,
          role: s.jobTitle ?? "",
        });
      }
    }

    const moduleMap = new Map<
      string,
      {
        moduleId: string;
        name: string;
        phase: string;
        orderIndex: number;
        activationType: string;
        activationCondition: string | null;
        status: "locked" | "active" | "completed";
        steps: {
          stepId: string;
          title: string;
          status: string;
          assignedTo: { id: string; name: string; role: string } | null;
          dueDate: string | null;
          completedAt: string | null;
          notes: string;
        }[];
      }
    >();

    for (const row of modules) {
      const mod = row.workflow_modules;
      const ts = row.workflow_template_steps;
      const cs = row.case_workflow_steps;
      const stepId = cs.id;

      if (!moduleMap.has(mod.id)) {
        moduleMap.set(mod.id, {
          moduleId: mod.id,
          name: mod.name,
          phase: mod.phase,
          orderIndex: mod.orderIndex,
          activationType: mod.activationType,
          activationCondition: mod.activationCondition,
          status: "locked",
          steps: [],
        });
      }

      const entry = moduleMap.get(mod.id)!;
      entry.steps.push({
        stepId,
        title: cs.title,
        status: cs.status,
        assignedTo: cs.assignedToId
          ? (staffMap.get(cs.assignedToId) ?? null)
          : null,
        dueDate: cs.dueDate,
        completedAt: cs.completedAt?.toISOString() ?? null,
        notes: cs.notes ?? "",
      });
    }

    const sortedModules = [...moduleMap.values()].sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );

    // Compute module status from step statuses
    const modulesWithStatus = sortedModules.map((mod) => {
      const stepStatuses = mod.steps.map((s) => s.status);
      const allCompleted = stepStatuses.every((s) => s === "completed");
      const anyInProgress = stepStatuses.some(
        (s) => s === "in_progress" || s === "in_review",
      );
      const anyStarted = stepStatuses.some(
        (s) => s === "in_progress" || s === "in_review" || s === "completed",
      );

      let status: "locked" | "active" | "completed";
      if (allCompleted) {
        status = "completed";
      } else if (anyInProgress) {
        status = "active";
      } else if (anyStarted) {
        status = "active";
      } else {
        // Check if previous module is completed
        const modIndex = sortedModules.indexOf(mod);
        if (modIndex === 0) {
          status = "active";
        } else {
          const prevModule = sortedModules[modIndex - 1];
          const prevAllCompleted = prevModule.steps.every(
            (s) => s.status === "completed",
          );
          status = prevAllCompleted ? "active" : "locked";
        }
      }

      return { ...mod, status };
    });

    const firstModule = modulesWithStatus[0];
    const startedSteps = modules.filter(
      (r) => r.case_workflow_steps.status !== "pending",
    );
    const startedAt =
      startedSteps.length > 0
        ? startedSteps[0].case_workflow_steps.createdAt.toISOString()
        : null;

    return {
      caseId,
      modules: modulesWithStatus,
      startedAt,
    };
  }

  // ─── Get workflow summary ───────────────────────────────────────────────────────

  async getWorkflowSummary(caseId: string, organizationId: string) {
    const steps = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      );

    const totalSteps = steps.length;
    const completedSteps = steps.filter((s) => s.status === "completed").length;
    const percentage =
      totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const inProgressStep = steps.find((s) => s.status === "in_progress");
    let currentModuleName: string | null = null;
    let currentModuleId: string | null = null;

    if (inProgressStep?.templateStepId) {
      const [templateStep] = await db
        .select()
        .from(workflowTemplateSteps)
        .where(eq(workflowTemplateSteps.id, inProgressStep.templateStepId))
        .limit(1);
      if (templateStep) {
        const [mod] = await db
          .select()
          .from(workflowModules)
          .where(eq(workflowModules.id, templateStep.moduleId))
          .limit(1);
        if (mod) {
          currentModuleName = mod.name;
          currentModuleId = mod.id;
        }
      }
    }

    return {
      templateName: "Workflow",
      totalSteps,
      completedSteps,
      percentage,
      currentModuleName,
      currentModuleId,
    };
  }

  // ─── Complete a step ────────────────────────────────────────────────────────────

  async completeStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status === "completed")
      return this.buildWorkflowResponse(caseId, organizationId);

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(caseWorkflowSteps)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(eq(caseWorkflowSteps.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "COMPLETED",
      title: `Step completed: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
      timeTakenMs,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_COMPLETED",
      title: `Step completed: ${step.title}`,
      metadata: {
        previousStatus: step.status,
        newStatus: "completed",
        timeTakenMs,
        completedById: performedById,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    // Auto-assign next pending step within same module
    await this.autoAssignNextStep(
      caseId,
      stepId,
      organizationId,
      performedById,
    );

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Assign staff to step ───────────────────────────────────────────────────────

  async assignStep(
    caseId: string,
    stepId: string,
    staffId: string,
    organizationId: string,
    overrideRationale?: string,
    performedById?: string,
  ) {
    const [step] = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");

    const [staffMember] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, staffId))
      .limit(1);

    if (!staffMember) throw new NotFoundError("Staff not found");

    const now = new Date();
    const updateData: Partial<typeof caseWorkflowSteps.$inferInsert> = {
      assignedToId: staffId,
      assignedAt: now,
      status: "in_progress",
      updatedAt: now,
    };

    if (overrideRationale) {
      updateData.overrideRationale = overrideRationale;
      updateData.overrideById = performedById ?? null;
      updateData.overrideAt = now;
    }

    await db
      .update(caseWorkflowSteps)
      .set(updateData)
      .where(eq(caseWorkflowSteps.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "ASSIGNED",
      title: `Step assigned: ${step.title}`,
      assigneeId: staffId,
      actorId: performedById ?? null,
      note: overrideRationale || null,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_ASSIGNED",
      title: `Step assigned: ${step.title}`,
      description: `Assigned to ${staffMember.firstName} ${staffMember.lastName}`,
      metadata: {
        assignmentStrategy: "manual_override",
        staffId,
        staffName: `${staffMember.firstName} ${staffMember.lastName}`,
        overrideRationale: overrideRationale ?? null,
        timestamp: now.toISOString(),
      },
      performedById: staffId,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Manually activate a module ─────────────────────────────────────────────────

  async activateModule(
    caseId: string,
    moduleId: string,
    organizationId: string,
  ) {
    const moduleSteps = await db
      .select()
      .from(caseWorkflowSteps)
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
          eq(workflowTemplateSteps.moduleId, moduleId),
        ),
      )
      .orderBy(asc(caseWorkflowSteps.orderIndex))
      .limit(1);

    if (moduleSteps.length === 0)
      throw new NotFoundError("No steps found for this module in the case");

    const firstStep = moduleSteps[0].case_workflow_steps;
    if (firstStep.status === "pending") {
      await db
        .update(caseWorkflowSteps)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(caseWorkflowSteps.id, firstStep.id));
    }

    const [mod] = await db
      .select()
      .from(workflowModules)
      .where(eq(workflowModules.id, moduleId))
      .limit(1);

    await logEvent({
      organizationId,
      caseId,
      moduleId,
      eventType: "MODULE_ACTIVATED",
      title: `Module activated: ${mod?.name ?? moduleId}`,
      metadata: {
        moduleName: mod?.name,
        activationType: mod?.activationType,
        timestamp: new Date().toISOString(),
      },
      performedById: null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Get timeline events ────────────────────────────────────────────────────────

  async getTimeline(caseId: string, organizationId: string) {
    const events = await db
      .select()
      .from(caseTimelineEvents)
      .where(eq(caseTimelineEvents.caseId, caseId))
      .orderBy(asc(caseTimelineEvents.createdAt));

    // Fetch step action logs for all steps in this case
    const actionLogRows = await db
      .select({
        log: stepActionLogs,
        stepTitle: caseWorkflowSteps.title,
      })
      .from(stepActionLogs)
      .innerJoin(
        caseWorkflowSteps,
        eq(stepActionLogs.stepId, caseWorkflowSteps.id),
      )
      .where(eq(caseWorkflowSteps.caseId, caseId))
      .orderBy(asc(stepActionLogs.createdAt));

    const ACTION_EVENT_MAP: Record<string, string> = {
      ASSIGNED: "step_assigned",
      SUBMITTED: "step_submitted_for_review",
      APPROVED: "step_approved",
      REJECTED: "step_rejected",
      COMPLETED: "step_completed",
    };

    const actionEvents = actionLogRows.map(({ log, stepTitle }) => {
      const eventType =
        ACTION_EVENT_MAP[log.action] ?? log.action.toLowerCase();
      return {
        id: log.id,
        eventType,
        title: log.title,
        description: log.note ?? null,
        metadata: {
          ...((log.metadata ?? {}) as Record<string, unknown>),
          stepTitle,
          note: log.note,
          actorName: log.actorName,
          assigneeName: log.assigneeName,
          assigneeId: log.assigneeId,
          timeTakenMs: log.timeTakenMs,
          action: log.action,
        } as Record<string, unknown> | null,
        actorId: log.actorId,
        createdAt: log.createdAt,
      };
    });

    // Merge and sort by createdAt
    const timelineEntries: {
      id: string;
      eventType: string;
      title: string;
      description: string | null;
      metadata: Record<string, unknown> | null;
      actorId: string | null;
      createdAt: Date;
    }[] = [
      ...events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        title: e.title,
        description: e.description,
        metadata: e.metadata as Record<string, unknown> | null,
        actorId: e.createdById,
        createdAt: e.createdAt,
      })),
      ...actionEvents,
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Resolve staff names
    const allStaffIds = [
      ...new Set(
        timelineEntries
          .map((e) => e.actorId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const staffMap = new Map<string, { id: string; name: string }>();
    if (allStaffIds.length > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, allStaffIds));
      for (const s of staffRows) {
        staffMap.set(s.id, { id: s.id, name: `${s.firstName} ${s.lastName}` });
      }
    }

    return timelineEntries.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      title: e.title,
      description: e.description,
      metadata: e.metadata as Record<string, unknown> | null,
      createdBy: e.actorId ? (staffMap.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ─── Get audit log ──────────────────────────────────────────────────────────────

  async getLogs(caseId: string, organizationId: string) {
    const logs = await db
      .select()
      .from(workflowLog)
      .where(
        and(
          eq(workflowLog.caseId, caseId),
          eq(workflowLog.organizationId, organizationId),
        ),
      )
      .orderBy(asc(workflowLog.createdAt));

    const staffIds = logs
      .map((l) => l.performedById)
      .filter((id): id is string => id !== null);

    const staffMap = new Map<string, { id: string; name: string }>();
    if (staffIds.length > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, staffIds));
      for (const s of staffRows) {
        staffMap.set(s.id, { id: s.id, name: `${s.firstName} ${s.lastName}` });
      }
    }

    return logs.map((l) => ({
      id: l.id,
      eventType: l.eventType,
      title: l.title,
      description: l.description,
      metadata: l.metadata,
      performedBy: l.performedById
        ? (staffMap.get(l.performedById) ?? null)
        : null,
      createdAt: l.createdAt.toISOString(),
    }));
  }

  // ─── Submit step for review (active → in_review) ────────────────────────────────

  async submitForReview(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_progress")
      throw new BadRequestError(
        "Step must be in_progress to submit for review",
      );

    const now = new Date();
    await db
      .update(caseWorkflowSteps)
      .set({ status: "in_review", updatedAt: now })
      .where(eq(caseWorkflowSteps.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "SUBMITTED",
      title: `Step submitted for review: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_SUBMITTED_FOR_REVIEW",
      title: `Step submitted for review: ${step.title}`,
      metadata: {
        previousStatus: "in_progress",
        newStatus: "in_review",
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Approve step (in_review → completed) ───────────────────────────────────────

  async approveStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review")
      throw new BadRequestError("Step must be in_review to approve");

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(caseWorkflowSteps)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(eq(caseWorkflowSteps.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "APPROVED",
      title: `Step approved: ${step.title}`,
      actorId: performedById,
      assigneeId: step.assignedToId,
      note: notes?.trim() || null,
      timeTakenMs,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_APPROVED",
      title: `Step approved: ${step.title}`,
      metadata: {
        previousStatus: "in_review",
        newStatus: "completed",
        reviewerId: performedById,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    // Auto-assign next step within same module
    await this.autoAssignNextStep(
      caseId,
      stepId,
      organizationId,
      performedById,
    );

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Reject step (in_review → active with feedback) ─────────────────────────────

  async rejectStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    feedback?: string,
  ) {
    const [step] = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review")
      throw new BadRequestError("Step must be in_review to reject");

    const now = new Date();
    await db
      .update(caseWorkflowSteps)
      .set({
        status: "in_progress",
        updatedAt: now,
      })
      .where(eq(caseWorkflowSteps.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "REJECTED",
      title: `Step rejected: ${step.title}`,
      actorId: performedById,
      note: feedback?.trim() || null,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_REJECTED",
      title: `Step rejected: ${step.title}`,
      description: feedback,
      metadata: {
        previousStatus: "in_review",
        newStatus: "in_progress",
        feedback,
        reviewerId: performedById,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Intelligent Staff Assignment Algorithm ─────────────────────────────────────

  // ─── Auto-assign next pending step after completion/approval ────────────────────

  private async autoAssignNextStep(
    caseId: string,
    currentStepId: string,
    organizationId: string,
    performedById?: string,
  ) {
    const allSteps = await db
      .select()
      .from(caseWorkflowSteps)
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .orderBy(
        asc(workflowModules.orderIndex),
        asc(workflowTemplateSteps.orderIndex),
      );

    const stepIndex = allSteps.findIndex(
      (row) => row.case_workflow_steps.id === currentStepId,
    );
    if (stepIndex === -1 || stepIndex >= allSteps.length - 1) return;

    const nextStep = allSteps[stepIndex + 1].case_workflow_steps;
    const nextModuleId =
      allSteps[stepIndex + 1].workflow_template_steps.moduleId;
    const currentModuleId =
      allSteps[stepIndex].workflow_template_steps.moduleId;

    // Only auto-trigger within same module
    if (nextModuleId !== currentModuleId || nextStep.status !== "pending")
      return;

    const picked = await pickBestStaff(
      organizationId,
      nextStep.templateStepId,
      performedById,
    );

    const now = new Date();
    const updateData: Record<string, unknown> = {
      status: "in_progress",
      updatedAt: now,
    };

    if (picked) {
      updateData.assignedToId = picked.id;
      updateData.assignedAt = now;

      await logStepAction({
        organizationId,
        caseId,
        stepId: nextStep.id,
        action: "ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        assigneeId: picked.id,
      });

      await logEvent({
        organizationId,
        caseId,
        stepId: nextStep.id,
        eventType: "STEP_ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        description: `Assigned to ${picked.firstName} ${picked.lastName}`,
        metadata: {
          assignmentStrategy: "workload_balanced",
          staffId: picked.id,
          staffName: `${picked.firstName} ${picked.lastName}`,
        },
        performedById: performedById ?? null,
      });
    }

    await db
      .update(caseWorkflowSteps)
      .set(updateData)
      .where(eq(caseWorkflowSteps.id, nextStep.id));
  }

  // ─── Case Notes ─────────────────────────────────────────────────────────────────

  async createNote(data: {
    caseId: string;
    organizationId: string;
    workflowModuleId?: string;
    taskId?: string;
    category?: string;
    visibility?: string;
    content: string;
    createdByUserId: string;
  }) {
    const [note] = await db
      .insert(caseNotes)
      .values({
        caseId: data.caseId,
        workflowModuleId: data.workflowModuleId,
        taskId: data.taskId,
        category: (data.category as any) ?? "internal_strategy",
        visibility: (data.visibility as any) ?? "all_staff",
        content: data.content,
        createdByUserId: data.createdByUserId,
      })
      .returning();
    return note;
  }

  async getNotes(caseId: string) {
    return db
      .select()
      .from(caseNotes)
      .where(eq(caseNotes.caseId, caseId))
      .orderBy(asc(caseNotes.createdAt));
  }

  async updateNote(
    noteId: string,
    caseId: string,
    data: { content?: string; category?: string; visibility?: string },
  ) {
    const [existing] = await db
      .select()
      .from(caseNotes)
      .where(and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Note not found");

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (data.content !== undefined) {
      updateFields.content = data.content;
      updateFields.isEdited = true;
    }
    if (data.category !== undefined) updateFields.category = data.category;
    if (data.visibility !== undefined)
      updateFields.visibility = data.visibility;

    const [updated] = await db
      .update(caseNotes)
      .set(updateFields)
      .where(eq(caseNotes.id, noteId))
      .returning();
    return updated;
  }

  async deleteNote(noteId: string, caseId: string) {
    const [existing] = await db
      .select()
      .from(caseNotes)
      .where(and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Note not found");

    await db.delete(caseNotes).where(eq(caseNotes.id, noteId));
  }

  // ─── Get my assigned tasks (for current staff member) ────────────────────────────

  async getMyTasks(
    staffId: string,
    organizationId: string,
    status?: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const statuses = (
      status
        ? status.split(",")
        : ["in_progress", "in_review", "completed", "pending", "skipped"]
    ) as ("completed" | "pending" | "in_progress" | "in_review" | "skipped")[];

    const baseConditions = and(
      eq(caseWorkflowSteps.assignedToId, staffId),
      eq(caseWorkflowSteps.organizationId, organizationId),
    );

    const countRows = await db
      .select({
        status: caseWorkflowSteps.status,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(caseWorkflowSteps)
      .where(baseConditions)
      .groupBy(caseWorkflowSteps.status);

    const counts: Record<string, number> = {
      in_progress: 0,
      in_review: 0,
      completed: 0,
      pending: 0,
      skipped: 0,
    };
    for (const r of countRows) {
      counts[r.status] = r.count;
    }

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(caseWorkflowSteps)
      .where(and(baseConditions, inArray(caseWorkflowSteps.status, statuses)));
    const total = Number(count);

    const filteredConditions = and(
      baseConditions,
      inArray(caseWorkflowSteps.status, statuses),
    );

    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        stepId: caseWorkflowSteps.id,
        stepTitle: caseWorkflowSteps.title,
        stepStatus: caseWorkflowSteps.status,
        stepAssignedAt: caseWorkflowSteps.assignedAt,
        stepDueDate: caseWorkflowSteps.dueDate,
        stepCreatedAt: caseWorkflowSteps.createdAt,
        stepNotes: caseWorkflowSteps.notes,
        stepUpdatedAt: caseWorkflowSteps.updatedAt,
        caseTitle: cases.caseNumber,
        caseId: cases.id,
        moduleName: workflowModules.name,
        moduleId: workflowModules.id,
        phaseName: workflowModules.phase,
      })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .where(filteredConditions)
      .orderBy(asc(caseWorkflowSteps.dueDate), asc(caseWorkflowSteps.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch step action logs for these steps
    const stepIds = rows.map((r) => r.stepId);
    const actionLogs =
      stepIds.length > 0
        ? await db
            .select()
            .from(stepActionLogs)
            .where(inArray(stepActionLogs.stepId, stepIds))
            .orderBy(asc(stepActionLogs.createdAt))
        : [];
    const logsByStep = new Map<string, typeof actionLogs>();
    for (const log of actionLogs) {
      const list = logsByStep.get(log.stepId) ?? [];
      list.push(log);
      logsByStep.set(log.stepId, list);
    }

    const data = rows.map((r) => ({
      stepId: r.stepId,
      caseId: r.caseId,
      caseTitle: r.caseTitle,
      title: r.stepTitle,
      status: r.stepStatus,
      moduleId: r.moduleId,
      moduleName: r.moduleName,
      phaseName: r.phaseName,
      assignedAt: r.stepAssignedAt?.toISOString() ?? null,
      dueDate: r.stepDueDate,
      createdAt: r.stepCreatedAt.toISOString(),
      updatedAt: r.stepUpdatedAt.toISOString(),
      auditLog: logsByStep.get(r.stepId) ?? [],
    }));

    return { data, counts, pagination: { total, limit, offset } };
  }

  // ─── Get review queue (all in_review steps across all cases) ────────────────────

  async getReviewQueue(
    organizationId: string,
    status?: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const statuses = (status ? status.split(",") : ["in_review"]) as (
      "completed" | "pending" | "in_progress" | "in_review" | "skipped"
    )[];

    const baseOrgCondition = eq(
      caseWorkflowSteps.organizationId,
      organizationId,
    );

    const countRows = await db
      .select({
        status: caseWorkflowSteps.status,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(caseWorkflowSteps)
      .where(baseOrgCondition)
      .groupBy(caseWorkflowSteps.status);

    const counts: Record<string, number> = {
      in_progress: 0,
      in_review: 0,
      completed: 0,
      pending: 0,
      skipped: 0,
    };
    for (const r of countRows) {
      counts[r.status] = r.count;
    }

    const baseConditions = and(
      baseOrgCondition,
      inArray(caseWorkflowSteps.status, statuses),
    );

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .leftJoin(staff, eq(caseWorkflowSteps.assignedToId, staff.id))
      .where(baseConditions);
    const total = Number(count);

    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        stepId: caseWorkflowSteps.id,
        stepTitle: caseWorkflowSteps.title,
        stepStatus: caseWorkflowSteps.status,
        stepUpdatedAt: caseWorkflowSteps.updatedAt,
        stepDueDate: caseWorkflowSteps.dueDate,
        stepNotes: caseWorkflowSteps.notes,
        caseTitle: cases.caseNumber,
        caseId: cases.id,
        moduleName: workflowModules.name,
        moduleId: workflowModules.id,
        phaseName: workflowModules.phase,
        assigneeFirstName: staff.firstName,
        assigneeLastName: staff.lastName,
      })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .leftJoin(staff, eq(caseWorkflowSteps.assignedToId, staff.id))
      .where(baseConditions)
      .orderBy(asc(caseWorkflowSteps.updatedAt))
      .limit(limit)
      .offset(offset);

    // Fetch step action logs for these steps
    const stepIds = rows.map((r) => r.stepId);
    const actionLogs =
      stepIds.length > 0
        ? await db
            .select()
            .from(stepActionLogs)
            .where(inArray(stepActionLogs.stepId, stepIds))
            .orderBy(asc(stepActionLogs.createdAt))
        : [];
    const logsByStep = new Map<string, typeof actionLogs>();
    for (const log of actionLogs) {
      const list = logsByStep.get(log.stepId) ?? [];
      list.push(log);
      logsByStep.set(log.stepId, list);
    }

    const data = rows.map((r) => ({
      stepId: r.stepId,
      caseId: r.caseId,
      caseTitle: r.caseTitle,
      title: r.stepTitle,
      status: r.stepStatus,
      moduleId: r.moduleId,
      moduleName: r.moduleName,
      phaseName: r.phaseName,
      assignedToName:
        r.assigneeFirstName && r.assigneeLastName
          ? `${r.assigneeFirstName} ${r.assigneeLastName}`
          : null,
      submittedAt: r.stepUpdatedAt?.toISOString() ?? null,
      dueDate: r.stepDueDate,
      auditLog: logsByStep.get(r.stepId) ?? [],
    }));

    return { data, counts, pagination: { total, limit, offset } };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────────

  private async getCase(caseId: string, organizationId: string) {
    const [caseRecord] = await db
      .select()
      .from(cases)
      .where(
        and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)),
      )
      .limit(1);
    if (!caseRecord) throw new NotFoundError("Case not found");
    return caseRecord;
  }

}

// ─── Standalone exported functions ──────────────────────────────────────────────

export async function pickBestStaff(
  organizationId: string,
  templateStepId?: string | null,
  excludeStaffId?: string,
  tx?: any,
): Promise<{ id: string; firstName: string; lastName: string } | null> {
  const conn = (tx ?? db) as typeof db;

  let candidates = await conn
    .select()
    .from(staff)
    .where(
      and(
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        excludeStaffId ? ne(staff.id, excludeStaffId) : undefined,
      ),
    );

  if (candidates.length === 0) {
    candidates = await conn
      .select()
      .from(staff)
      .where(
        and(
          eq(staff.organizationId, organizationId),
          ne(staff.status, "inactive"),
          excludeStaffId ? ne(staff.id, excludeStaffId) : undefined,
        ),
      );
  }

  if (candidates.length === 0) return null;

  if (templateStepId) {
    const [templateStep] = await conn
      .select()
      .from(workflowTemplateSteps)
      .where(eq(workflowTemplateSteps.id, templateStepId))
      .limit(1);

    const requiredCert = templateStep?.requiredCertification;
    if (requiredCert) {
      const certifiedStaffIds = await conn
        .select({ staffId: staffCertifications.staffId })
        .from(staffCertifications)
        .innerJoin(certifications, eq(certifications.id, staffCertifications.certificationId))
        .where(eq(certifications.name, requiredCert));

      const certSet = new Set(certifiedStaffIds.map((r) => r.staffId));
      candidates = candidates.filter((s) => certSet.has(s.id));
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return {
      id: candidates[0].id,
      firstName: candidates[0].firstName,
      lastName: candidates[0].lastName,
    };
  }

  const todayStr = new Date().toISOString().split("T")[0];
  const staffOnLeave = await conn
    .select({ staffId: leaveRequests.staffId })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.organizationId, organizationId),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startDate, todayStr),
        gte(leaveRequests.endDate, todayStr),
      ),
    );

  const leaveSet = new Set(staffOnLeave.map((r) => r.staffId));
  const availableStaff = candidates.filter((s) => !leaveSet.has(s.id));
  const pool = availableStaff.length > 0 ? availableStaff : candidates;

  const staffIds = pool.map((s) => s.id);
  const loadRows = await conn
    .select({
      staffId: caseWorkflowSteps.assignedToId,
      taskCount: count(),
    })
    .from(caseWorkflowSteps)
    .where(
      and(
        inArray(caseWorkflowSteps.assignedToId, staffIds),
        inArray(caseWorkflowSteps.status, ["in_progress", "in_review"]),
      ),
    )
    .groupBy(caseWorkflowSteps.assignedToId);

  const loadMap = new Map<string, number>();
  for (const row of loadRows) {
    if (row.staffId) loadMap.set(row.staffId, row.taskCount);
  }

  const recentAssignments = await conn
    .select({
      staffId: caseWorkflowSteps.assignedToId,
      lastAssigned: sql<string>`MAX(${caseWorkflowSteps.assignedAt})`.as("last_assigned"),
    })
    .from(caseWorkflowSteps)
    .where(
      and(
        inArray(caseWorkflowSteps.assignedToId, staffIds),
        sql`${caseWorkflowSteps.assignedAt} IS NOT NULL`,
      ),
    )
    .groupBy(caseWorkflowSteps.assignedToId);

  const lastAssignedMap = new Map<string, Date>();
  for (const row of recentAssignments) {
    if (row.staffId) lastAssignedMap.set(row.staffId, new Date(row.lastAssigned));
  }

  const scored = pool.map((s) => ({
    staff: s,
    load: loadMap.get(s.id) ?? 0,
    lastAssigned: lastAssignedMap.get(s.id) ?? null,
  }));

  scored.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    if (a.lastAssigned && b.lastAssigned) {
      return a.lastAssigned.getTime() - b.lastAssigned.getTime();
    }
    if (!a.lastAssigned && b.lastAssigned) return -1;
    if (a.lastAssigned && !b.lastAssigned) return 1;
    return 0;
  });

  const picked = scored[0];
  return {
    id: picked.staff.id,
    firstName: picked.staff.firstName,
    lastName: picked.staff.lastName,
  };
}

export async function logEvent(data: {
  organizationId: string;
  caseId: string;
  stepId?: string;
  moduleId?: string;
  eventType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  performedById: string | null;
  tx?: any;
}) {
  const conn = (data.tx ?? db) as typeof db;
  await conn.insert(workflowLog).values({
    organizationId: data.organizationId,
    caseId: data.caseId,
    stepId: data.stepId,
    moduleId: data.moduleId,
    eventType: data.eventType,
    title: data.title,
    description: data.description,
    metadata: (data.metadata as any) ?? null,
    performedById: data.performedById,
  });
}

export async function logStepAction(data: {
  organizationId: string;
  caseId: string;
  stepId: string;
  action: string;
  title: string;
  actorId?: string | null;
  assigneeId?: string | null;
  moduleId?: string | null;
  note?: string | null;
  timeTakenMs?: number | null;
  metadata?: Record<string, unknown> | null;
  tx?: any;
}) {
  const conn = (data.tx ?? db) as typeof db;

  const staffIds = [data.actorId, data.assigneeId].filter(
    (id): id is string => id != null,
  );
  const nameMap = new Map<string, string>();
  if (staffIds.length > 0) {
    const rows = await conn
      .select({
        id: staff.id,
        firstName: staff.firstName,
        lastName: staff.lastName,
      })
      .from(staff)
      .where(inArray(staff.id, staffIds));
    for (const s of rows) {
      nameMap.set(s.id, `${s.firstName} ${s.lastName}`);
    }
  }

  await conn.insert(stepActionLogs).values({
    organizationId: data.organizationId,
    caseId: data.caseId,
    stepId: data.stepId,
    moduleId: data.moduleId ?? null,
    action: data.action,
    title: data.title,
    actorId: data.actorId ?? null,
    actorName: data.actorId ? (nameMap.get(data.actorId) ?? null) : null,
    assigneeId: data.assigneeId ?? null,
    assigneeName: data.assigneeId ? (nameMap.get(data.assigneeId) ?? null) : null,
    note: data.note ?? null,
    timeTakenMs: data.timeTakenMs ?? null,
    metadata: (data.metadata as any) ?? null,
  });
}
