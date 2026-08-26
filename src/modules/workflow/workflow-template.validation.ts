import { z } from "zod";
import type { Condition, ConditionField } from "../../db/schema/workflow";

/**
 * The closed `ConditionField` union, as a runtime value.
 *
 * Kept next to the type it mirrors and cross-checked by
 * `workflow-template.validation.test.ts`, so adding a field to the union
 * without adding it here fails a test rather than silently rejecting every
 * template that uses the new field.
 */
export const CONDITION_FIELDS = [
  "immigrationDetails.filingTrack",
  "immigrationDetails.naturalizationTrack",
  "immigrationDetails.isConditionalResidence",
  "immigrationDetails.priorityDateIsCurrent",
  "personalInjuryDetails.defendantType",
  "personalInjuryDetails.isMinorPlaintiff",
  "case.priority",
] as const satisfies readonly ConditionField[];

const conditionFieldSchema = z.enum(CONDITION_FIELDS);

/**
 * Validates a module's `activationCondition` at **save time**, not only when
 * it is evaluated.
 *
 * A condition naming a field outside the union would otherwise evaluate to
 * false forever, and a module that silently never activates is close to
 * impossible to debug from the outside — the tasks simply never appear. This
 * turns that into a rejected save with a message.
 */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({
      field: conditionFieldSchema,
      op: z.enum(["eq", "neq"]),
      value: z.union([z.string(), z.boolean()]),
    }),
    z.object({
      field: conditionFieldSchema,
      op: z.literal("in"),
      value: z.array(z.string()),
    }),
    z.object({ allOf: z.array(conditionSchema).min(1) }),
    z.object({ anyOf: z.array(conditionSchema).min(1) }),
  ]),
);

export const updateModuleBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    phase: z.string().min(1).optional(),
    activationType: z.enum(["auto", "conditional", "manual"]).optional(),
    activationCondition: conditionSchema.nullable().optional(),
    orderIndex: z.number().int().min(0).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "No fields to update" })
  .refine(
    (body) => body.activationType !== "conditional" || body.activationCondition !== null,
    { message: "A conditional module needs an activationCondition", path: ["activationCondition"] },
  );

export const templateQuery = z.object({
  caseTypeId: z.string().uuid(),
});

export const linkCaseBody = z.object({
  childCaseId: z.string().uuid(),
  relationType: z.enum(["mandamus", "appeal", "related_matter"]),
});
