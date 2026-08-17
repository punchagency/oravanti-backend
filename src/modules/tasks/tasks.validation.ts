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
 */
export const updateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().min(1).max(20_000).optional(),
    caseId: uuid.optional(),
    teamId: z.string().min(1).nullable().optional(),
    assignedToId: uuid.optional(),
    dueDate: isoDate.optional(),
    priority: z.enum(taskPriorityEnum.enumValues).optional(),
    status: z.enum(taskStatusEnum.enumValues).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    requiredCertifications: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateTaskInput = z.infer<typeof updateTaskBody>;
