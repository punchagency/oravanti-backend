import { and, eq, isNull } from "drizzle-orm";
import { db } from "../client";
import {
  intakePipelineTemplateSteps,
  intakePipelineTemplates,
} from "../schema/intake-pipeline-templates";

type Stage =
  | "lead_inbox"
  | "conflict_check"
  | "questionnaire"
  | "consultation"
  | "fee_agreement"
  | "case_opening";

interface StepDef {
  title: string;
  description: string;
  pipelineStage: Stage;
  orderIndex: number;
  isRequired?: boolean;
}

export const SYSTEM_INTAKE_TEMPLATE_NAME = "Default intake pipeline";

/**
 * The intake checklist every new lead starts with.
 *
 * This array is the *seed input*, not the runtime source: once seeded,
 * `initializePipelineSteps` reads the steps back out of the database, so a firm
 * can edit its own checklist without a deploy.
 *
 * Conflict check is one step, not two — running the check and acting on its
 * result happen on the same screen, so splitting them left a second task that
 * was only ever ticked off as bookkeeping.
 */
export const DEFAULT_INTAKE_PIPELINE_STEPS: StepDef[] = [
  {
    title: "Run & review conflict check",
    description:
      "Check for conflicts of interest with existing clients and adverse parties, then clear or decline the lead",
    pipelineStage: "conflict_check",
    orderIndex: 0,
  },
  {
    title: "Send intake questionnaire",
    description:
      "Send the intake questionnaire to the lead for detailed information",
    pipelineStage: "questionnaire",
    orderIndex: 0,
  },
  {
    title: "Review questionnaire responses",
    description: "Review and analyze the completed intake questionnaire",
    pipelineStage: "questionnaire",
    orderIndex: 1,
  },
  {
    title: "Schedule consultation",
    description: "Book initial consultation with the lead",
    pipelineStage: "consultation",
    orderIndex: 0,
  },
  {
    title: "Conduct consultation",
    description: "Hold the initial consultation meeting",
    pipelineStage: "consultation",
    orderIndex: 1,
  },
  {
    title: "Prepare fee agreement",
    description: "Draft the fee agreement for the lead",
    pipelineStage: "fee_agreement",
    orderIndex: 0,
  },
  {
    title: "Send fee agreement",
    description: "Send fee agreement to lead for signature",
    pipelineStage: "fee_agreement",
    orderIndex: 1,
  },
  {
    title: "Receive signed fee agreement",
    description: "Confirm receipt of the signed fee agreement",
    pipelineStage: "fee_agreement",
    orderIndex: 2,
  },
  {
    title: "Open case file",
    description: "Convert lead to active case and create case file",
    pipelineStage: "case_opening",
    orderIndex: 0,
  },
];

/**
 * Creates (or refreshes) the system-default intake pipeline template.
 *
 * Idempotent: re-running replaces the default template's steps rather than
 * duplicating them, and never touches a firm's own template. Leads already
 * stamped keep the tasks they were given — this only changes what *new* leads
 * get.
 *
 * @param organizationId Seed a firm-specific template instead of the system
 *   default. Omit for the default.
 */
export async function seedIntakePipeline(organizationId?: string) {
  const scope = organizationId
    ? eq(intakePipelineTemplates.organizationId, organizationId)
    : isNull(intakePipelineTemplates.organizationId);

  const [existing] = await db
    .select()
    .from(intakePipelineTemplates)
    .where(and(scope, eq(intakePipelineTemplates.isActive, true)))
    .limit(1);

  let templateId: string;

  if (existing) {
    templateId = existing.id;
    // Replace wholesale: a diff would have to reconcile renames, and the steps
    // are the template's entire content.
    await db
      .delete(intakePipelineTemplateSteps)
      .where(eq(intakePipelineTemplateSteps.templateId, templateId));
    await db
      .update(intakePipelineTemplates)
      .set({ updatedAt: new Date() })
      .where(eq(intakePipelineTemplates.id, templateId));
  } else {
    const [created] = await db
      .insert(intakePipelineTemplates)
      .values({
        organizationId: organizationId ?? null,
        name: organizationId
          ? "Intake pipeline"
          : SYSTEM_INTAKE_TEMPLATE_NAME,
        description:
          "Steps stamped onto every new lead when its intake pipeline is initialized",
      })
      .returning();
    templateId = created.id;
  }

  await db.insert(intakePipelineTemplateSteps).values(
    DEFAULT_INTAKE_PIPELINE_STEPS.map((step) => ({
      templateId,
      title: step.title,
      description: step.description,
      pipelineStage: step.pipelineStage,
      orderIndex: step.orderIndex,
      isRequired: step.isRequired ?? true,
    })),
  );

  console.log(
    `Seeded ${DEFAULT_INTAKE_PIPELINE_STEPS.length} intake pipeline steps into ` +
      `${organizationId ? `organization ${organizationId}` : "the system default"} template ${templateId}`,
  );

  return templateId;
}
