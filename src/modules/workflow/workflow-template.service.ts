import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { workflowModules, workflowTemplates, workflowTemplateSteps } from "../../db/schema/workflow";
import { AuthorizationError, NotFoundError } from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";

/**
 * Resolves which workflow template a case's tasks materialize from.
 *
 * Directly mirrors `findActiveTemplateId` in `intake-pipeline-template.service.ts`:
 * a firm's own active template for this case type wins; otherwise the system
 * default (the row with a null `organizationId`). Newest active row per scope,
 * so publishing a revision is a plain insert rather than an in-place edit.
 */
export async function resolveWorkflowTemplateId(
  organizationId: string,
  caseTypeId: string,
): Promise<string | null> {
  const [own] = await db
    .select({ id: workflowTemplates.id })
    .from(workflowTemplates)
    .where(
      and(
        eq(workflowTemplates.organizationId, organizationId),
        eq(workflowTemplates.caseTypeId, caseTypeId),
        eq(workflowTemplates.isActive, true),
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt))
    .limit(1);
  if (own) return own.id;

  const [systemDefault] = await db
    .select({ id: workflowTemplates.id })
    .from(workflowTemplates)
    .where(
      and(
        isNull(workflowTemplates.organizationId),
        eq(workflowTemplates.caseTypeId, caseTypeId),
        eq(workflowTemplates.isActive, true),
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt))
    .limit(1);

  return systemDefault?.id ?? null;
}

/**
 * A template as the tree it actually is: the template row, its modules in
 * order, and each module's steps nested inside it in order.
 *
 * Nested rather than three sibling arrays. A template is only ever read as a
 * tree — to render the module/step outline, to know which steps are locked, to
 * tell a conditional module that hasn't activated from one that isn't in this
 * template — so returning `{ template, modules, steps }` made every consumer
 * redo the same group-by, and a consumer that forgot got an empty outline with
 * no error. Two queries either way; the join happens once, here.
 */
export async function loadTemplateWithModulesAndSteps(templateId: string) {
  const [template] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId)).limit(1);
  if (!template) throw new NotFoundError("Workflow template not found");

  const modules = await db
    .select()
    .from(workflowModules)
    .where(eq(workflowModules.templateId, templateId))
    .orderBy(asc(workflowModules.orderIndex));

  const steps =
    modules.length > 0
      ? await db
          .select()
          .from(workflowTemplateSteps)
          .where(inArray(workflowTemplateSteps.moduleId, modules.map((m) => m.id)))
          .orderBy(asc(workflowTemplateSteps.orderIndex))
      : [];

  const stepsByModule = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsByModule.get(step.moduleId) ?? [];
    list.push(step);
    stepsByModule.set(step.moduleId, list);
  }

  return {
    ...template,
    // Always an array, never undefined — a module with no steps must still be
    // iterable, which is exactly the shape bug this replaces.
    modules: modules.map((mod) => ({ ...mod, steps: stepsByModule.get(mod.id) ?? [] })),
  };
}

/**
 * A firm's first edit to a locked system-default template clones the whole
 * thing (modules + steps) into an org-owned row rather than mutating the
 * shared default in place — same reasoning as why editing a
 * `caseTypeDocumentRequirements` row never rewrites already-materialized
 * `scenarioDocumentRequirements` rows, one level up. `isLocked` steps survive
 * the clone unchanged; a firm can add, reorder, or remove their own non-locked
 * steps and add whole new modules after cloning.
 */
export async function cloneTemplateForOrganization(
  systemTemplateId: string,
  organizationId: string,
  actorStaffId: string | null,
): Promise<string> {
  const [systemTemplate] = await db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.id, systemTemplateId), isNull(workflowTemplates.organizationId)))
    .limit(1);
  if (!systemTemplate) throw new NotFoundError("System-default workflow template not found");

  const modules = await db
    .select()
    .from(workflowModules)
    .where(eq(workflowModules.templateId, systemTemplateId))
    .orderBy(workflowModules.orderIndex);

  const [clonedTemplate] = await db
    .insert(workflowTemplates)
    .values({
      organizationId,
      caseTypeId: systemTemplate.caseTypeId,
      name: systemTemplate.name,
      isActive: true,
    })
    .returning();

  for (const mod of modules) {
    const steps = await db
      .select()
      .from(workflowTemplateSteps)
      .where(eq(workflowTemplateSteps.moduleId, mod.id))
      .orderBy(workflowTemplateSteps.orderIndex);

    const [clonedModule] = await db
      .insert(workflowModules)
      .values({
        templateId: clonedTemplate.id,
        name: mod.name,
        description: mod.description,
        phase: mod.phase,
        activationType: mod.activationType,
        activationCondition: mod.activationCondition,
        orderIndex: mod.orderIndex,
      })
      .returning();

    if (steps.length > 0) {
      await db.insert(workflowTemplateSteps).values(
        steps.map((s) => ({
          moduleId: clonedModule.id,
          title: s.title,
          description: s.description,
          orderIndex: s.orderIndex,
          dueDateAnchor: s.dueDateAnchor,
          dueDateOffsetDays: s.dueDateOffsetDays,
          isRequired: s.isRequired,
          isLocked: s.isLocked,
          requiredCertifications: s.requiredCertifications,
          assignableRoles: s.assignableRoles,
        })),
      );
    }
  }

  await recordAuditEvent({
    action: "workflow_template.created",
    entityType: "workflow_template",
    entityId: clonedTemplate.id,
    organizationId,
    summary: `Workflow template "${clonedTemplate.name}" cloned from system default`,
    metadata: { sourceTemplateId: systemTemplateId },
    actor: actorStaffId ? { staffId: actorStaffId } : undefined,
  });

  return clonedTemplate.id;
}

/**
 * Edits one module on a firm's own template.
 *
 * Refuses outright on a system default (`organizationId IS NULL`). That row is
 * shared by every firm on the platform, so an in-place edit would silently
 * rewrite the backbone for all of them — the caller must clone it first, which
 * is the whole point of `cloneTemplateForOrganization`. The RLS policy already
 * denies the write, but failing here gives a message that says what to do
 * instead of a bare permission error.
 *
 * Locked *steps* are untouched by this: a module's own fields carry no
 * statutory weight, and step-level editing is deliberately not exposed — the
 * locked-backbone guarantee is that a firm cannot weaken a locked step's
 * anchor, offset, or certifications at all through this surface.
 */
export async function updateTemplateModule(
  moduleId: string,
  organizationId: string,
  patch: Partial<Pick<typeof workflowModules.$inferInsert, "name" | "description" | "phase" | "activationType" | "activationCondition" | "orderIndex">>,
  actorStaffId: string | null,
): Promise<typeof workflowModules.$inferSelect> {
  const [row] = await db
    .select({ module: workflowModules, templateOrganizationId: workflowTemplates.organizationId, templateName: workflowTemplates.name })
    .from(workflowModules)
    .innerJoin(workflowTemplates, eq(workflowTemplates.id, workflowModules.templateId))
    .where(eq(workflowModules.id, moduleId))
    .limit(1);

  if (!row) throw new NotFoundError("Workflow module not found");

  if (row.templateOrganizationId === null) {
    throw new AuthorizationError(
      "This module belongs to a shared system-default template. Clone the template for your firm before editing it.",
    );
  }
  if (row.templateOrganizationId !== organizationId) {
    throw new NotFoundError("Workflow module not found");
  }

  const [updated] = await db
    .update(workflowModules)
    .set(patch)
    .where(eq(workflowModules.id, moduleId))
    .returning();

  await recordAuditEvent({
    action: "workflow_template.updated",
    entityType: "workflow_template",
    entityId: row.module.templateId,
    organizationId,
    summary: `Module "${updated.name}" updated on template "${row.templateName}"`,
    metadata: { moduleId, fields: Object.keys(patch) },
    actor: actorStaffId ? { staffId: actorStaffId } : undefined,
  });

  return updated;
}
