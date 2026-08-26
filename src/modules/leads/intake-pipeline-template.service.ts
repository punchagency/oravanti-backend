import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  intakePipelineTemplateSteps,
  intakePipelineTemplates,
  type IntakePipelineTemplateStep,
} from "../../db/schema/intake-pipeline-templates";
import { leadPipelineStageEnum } from "../../db/schema/leads";
import { seedIntakePipeline } from "../../db/seeds/intake-pipeline.seed";
import { createModuleLogger } from "../../lib/logging/log";
import { NotFoundError } from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";

const log = createModuleLogger("leads.intake-pipeline-template");

type PipelineStage = (typeof leadPipelineStageEnum.enumValues)[number];

/**
 * Resolves which intake checklist a firm's new leads should get.
 *
 * A firm's own active template wins; otherwise the system default (the row with
 * a null `organizationId`). Newest active row per scope, so publishing a
 * revision is a plain insert rather than an in-place edit.
 */
async function findActiveTemplateId(
  organizationId: string,
): Promise<string | null> {
  const [own] = await db
    .select({ id: intakePipelineTemplates.id })
    .from(intakePipelineTemplates)
    .where(
      and(
        eq(intakePipelineTemplates.organizationId, organizationId),
        eq(intakePipelineTemplates.isActive, true),
      ),
    )
    .orderBy(desc(intakePipelineTemplates.createdAt))
    .limit(1);
  if (own) return own.id;

  const [fallback] = await db
    .select({ id: intakePipelineTemplates.id })
    .from(intakePipelineTemplates)
    .where(
      and(
        isNull(intakePipelineTemplates.organizationId),
        eq(intakePipelineTemplates.isActive, true),
      ),
    )
    .orderBy(desc(intakePipelineTemplates.createdAt))
    .limit(1);

  return fallback?.id ?? null;
}

async function loadSteps(templateId: string) {
  return db
    .select()
    .from(intakePipelineTemplateSteps)
    .where(eq(intakePipelineTemplateSteps.templateId, templateId))
    .orderBy(
      asc(intakePipelineTemplateSteps.pipelineStage),
      asc(intakePipelineTemplateSteps.orderIndex),
    );
}

/**
 * The active template's id, seeding the system default if nothing exists.
 *
 * Seeds rather than throwing: a database that has never been seeded would
 * otherwise produce leads with an empty pipeline, and that failure surfaces far
 * from its cause.
 */
async function resolveTemplateId(organizationId: string): Promise<string> {
  const existing = await findActiveTemplateId(organizationId);
  if (existing) return existing;

  log.warn("lead.pipeline_template_missing");
  return seedIntakePipeline();
}

/** The steps to stamp onto a new lead, read from the database. */
export async function resolveIntakePipelineSteps(
  organizationId: string,
): Promise<IntakePipelineTemplateStep[]> {
  const templateId = await resolveTemplateId(organizationId);
  const steps = await loadSteps(templateId);

  // A template that exists but has no steps is a broken seed, not a valid
  // "empty checklist" — repair it rather than silently stamping nothing.
  if (steps.length === 0) {
    const reseeded = await seedIntakePipeline();
    return loadSteps(reseeded);
  }

  return steps;
}

/**
 * The active template and its steps, for the settings screen.
 *
 * A firm that has never edited its checklist gets the system default back, with
 * `organizationId: null` on the template row — that null is what tells the
 * editor it is looking at the shared default and that saving will fork it.
 */
export async function getIntakePipelineTemplate(organizationId: string) {
  const templateId = await resolveTemplateId(organizationId);

  const [template] = await db
    .select()
    .from(intakePipelineTemplates)
    .where(eq(intakePipelineTemplates.id, templateId))
    .limit(1);
  if (!template) throw new NotFoundError("Intake pipeline template not found");

  return { ...template, steps: await loadSteps(templateId) };
}

/** One step as the settings screen sends it. Order is the array's own; `orderIndex` is derived. */
export interface IntakePipelineStepInput {
  title: string;
  description?: string | null;
  pipelineStage: PipelineStage;
  isRequired?: boolean;
  assignableRoles?: string[];
}

/**
 * The firm's own template, forked from the system default on first edit.
 *
 * Clone-on-first-edit, same rule as `cloneTemplateForOrganization`: the
 * `organizationId IS NULL` row is shared by every firm on the platform, so an
 * in-place edit would rewrite everyone's checklist. Unlike the workflow clone
 * this copies no steps — the caller is about to replace the whole list anyway,
 * and it fetched the default to edit from.
 */
async function ensureOwnTemplate(
  organizationId: string,
  actorStaffId: string | null,
): Promise<string> {
  const [own] = await db
    .select({ id: intakePipelineTemplates.id })
    .from(intakePipelineTemplates)
    .where(
      and(
        eq(intakePipelineTemplates.organizationId, organizationId),
        eq(intakePipelineTemplates.isActive, true),
      ),
    )
    .orderBy(desc(intakePipelineTemplates.createdAt))
    .limit(1);
  if (own) return own.id;

  const [created] = await db
    .insert(intakePipelineTemplates)
    .values({
      organizationId,
      name: "Intake pipeline",
      description:
        "Steps stamped onto every new lead when its intake pipeline is initialized",
    })
    .returning();

  await recordAuditEvent({
    action: "intake_pipeline.template_created",
    entityId: created.id,
    organizationId,
    summary: "Firm intake checklist created from the system default",
    actor: actorStaffId ? { staffId: actorStaffId } : undefined,
  });

  return created.id;
}

/**
 * Replaces the firm's intake checklist wholesale.
 *
 * Wholesale rather than per-step CRUD because the steps *are* the template's
 * content: a diff would have to reconcile renames and reorders against rows the
 * client never had ids for, and the editor is a single list the user saves once.
 * `seedIntakePipeline` already replaces on the same reasoning.
 *
 * `orderIndex` is derived from the array, per stage — the client sends the list
 * in the order it wants and never maintains an index. Already-stamped leads keep
 * the tasks they were given; this only changes what *new* leads get, which is
 * the same guarantee the seed makes.
 */
export async function saveIntakePipelineSteps(
  organizationId: string,
  steps: IntakePipelineStepInput[],
  actorStaffId: string | null,
) {
  const templateId = await ensureOwnTemplate(organizationId, actorStaffId);
  const perStage = new Map<PipelineStage, number>();

  const rows = steps.map((step) => {
    const orderIndex = perStage.get(step.pipelineStage) ?? 0;
    perStage.set(step.pipelineStage, orderIndex + 1);

    return {
      templateId,
      title: step.title,
      description: step.description ?? null,
      pipelineStage: step.pipelineStage,
      orderIndex,
      isRequired: step.isRequired ?? true,
      assignableRoles: step.assignableRoles ?? [],
    };
  });

  await db.transaction(async (tx) => {
    await tx
      .delete(intakePipelineTemplateSteps)
      .where(eq(intakePipelineTemplateSteps.templateId, templateId));
    if (rows.length > 0) await tx.insert(intakePipelineTemplateSteps).values(rows);
    await tx
      .update(intakePipelineTemplates)
      .set({ updatedAt: new Date() })
      .where(eq(intakePipelineTemplates.id, templateId));
  });

  await recordAuditEvent({
    action: "intake_pipeline.template_updated",
    entityId: templateId,
    organizationId,
    summary: `Intake checklist saved with ${rows.length} step${rows.length === 1 ? "" : "s"}`,
    metadata: { stepCount: rows.length },
    actor: actorStaffId ? { staffId: actorStaffId } : undefined,
  });

  return getIntakePipelineTemplate(organizationId);
}
