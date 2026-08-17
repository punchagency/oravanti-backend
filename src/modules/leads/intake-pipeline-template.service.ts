import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  intakePipelineTemplateSteps,
  intakePipelineTemplates,
  type IntakePipelineTemplateStep,
} from "../../db/schema/intake-pipeline-templates";
import { seedIntakePipeline } from "../../db/seeds/intake-pipeline.seed";

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
 * The steps to stamp onto a new lead, read from the database.
 *
 * Seeds the system default on first use rather than throwing: a database that
 * has never been seeded would otherwise produce leads with an empty pipeline,
 * and that failure surfaces far from its cause.
 */
export async function resolveIntakePipelineSteps(
  organizationId: string,
): Promise<IntakePipelineTemplateStep[]> {
  let templateId = await findActiveTemplateId(organizationId);

  if (!templateId) {
    console.warn(
      "No intake pipeline template found — seeding the system default on demand.",
    );
    templateId = await seedIntakePipeline();
  }

  const steps = await loadSteps(templateId);

  // A template that exists but has no steps is a broken seed, not a valid
  // "empty checklist" — repair it rather than silently stamping nothing.
  if (steps.length === 0) {
    const reseeded = await seedIntakePipeline();
    return loadSteps(reseeded);
  }

  return steps;
}

/** The active template and its steps, for the settings screen. */
export async function getIntakePipelineTemplate(organizationId: string) {
  const templateId = await findActiveTemplateId(organizationId);
  if (!templateId) return null;

  const [template] = await db
    .select()
    .from(intakePipelineTemplates)
    .where(eq(intakePipelineTemplates.id, templateId))
    .limit(1);
  if (!template) return null;

  return { ...template, steps: await loadSteps(templateId) };
}
