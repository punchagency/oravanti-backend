import { z } from "zod";
import { taskPriorityEnum, taskStatusEnum } from "../../db/schema/tasks";

/**
 * Request schemas for the tasks module.
 *
 * Replaces `CommonValidation.optionalBody()` on update, which fed
 * `Partial<typeof tasks.$inferInsert>` into `.set()` — making `organizationId`
 * and `assignedById` writable by the caller. The latter is the attribution
 * recorded against the task, so it should never come from the request.
 */

const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD format");

export const taskIdParams = z.object({ id: uuid });

/**
 * `organizationId` (tenancy) and `assignedById` (attribution — taken from the
 * authenticated actor) are deliberately not writable.
 *
 * Neither is `assignedToId`: assignment has its own endpoint,
 * `PATCH /tasks/:id/assign`, because it has rules a generic patch does not —
 * a case task may only go to someone on the case's team, and the handover is
 * recorded on the case or lead timeline. Two ways to assign is exactly the
 * drift that consolidating these tables was meant to end.
 */
export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    caseId: uuid.optional(),
    teamId: z.string().min(1).nullable().optional(),
    dueDate: isoDate.optional(),
    priority: z.enum(taskPriorityEnum.enumValues).optional(),
    status: z.enum(taskStatusEnum.enumValues).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    requiredCertifications: z.array(z.string().trim().min(1)).max(50).optional(),
    notes: z.string().trim().max(20_000).nullable().optional(),
    /**
     * Why a locked step is being weakened. Required — and only meaningful —
     * when the task is `isLocked` and the patch touches one of the protected
     * fields; see `lockedOverrideViolation` in tasks.service.ts, which is where
     * the requirement is enforced, since whether it applies depends on the
     * stored row rather than on the body alone.
     *
     * Long enough that "n/a" doesn't pass: the whole value of the override
     * trail is that someone had to state a reason.
     */
    overrideRationale: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateTaskInput = z.infer<typeof updateTaskBody>;

/**
 * The note attached to a lifecycle move.
 *
 * One schema for all five verbs. It is optional here even for `reject`, whose
 * feedback is mandatory: whether a note is required depends on the verb, and
 * `transitionViolation` — the state machine itself — is the one place that
 * decides, so the rule cannot be enforced in one spot and forgotten in the
 * other.
 */
export const taskTransitionBody = z
  .object({ note: z.string().trim().min(1).max(20_000).optional() })
  .strict();

export const assignTaskBody = z
  .object({
    assignedToId: uuid,
    /** Required to reassign a locked step; enforced against the stored row. */
    overrideRationale: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict();
