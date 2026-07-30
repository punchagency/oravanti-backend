/**
 * Guard for "who may this work be assigned to".
 *
 * Assignment columns (`lead_tasks.assigned_to_id`, `tasks.assigned_to_id`,
 * `case_workflow_steps.assigned_to_id`, ...) reference `staff.id` with no
 * organization in the foreign key, and `staff` carries no RLS policy — so an id
 * from another firm satisfies the constraint and the database will accept it.
 * Every assignment path therefore has to check tenancy itself.
 *
 * Scope note: this asserts firm membership only. Whether an inactive or
 * on-leave staff member may hold an assignment is a product question — the
 * auto-assign heuristic in `WorkflowService.pickBestStaff` has its own,
 * stricter rules — and is deliberately not decided here.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { staff } from "../db/schema/staff";
import { BadRequestError } from "./error/app-error";

/**
 * Throw unless `staffId` belongs to `organizationId`.
 *
 * The error is deliberately vague about whether the id exists at all: a caller
 * probing ids should not learn which ones are real staff in another firm.
 */
export const assertAssignableStaff = async (
  staffId: string,
  organizationId: string,
): Promise<void> => {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.organizationId, organizationId)))
    .limit(1);

  if (!row) {
    throw new BadRequestError("That staff member is not part of this firm");
  }
};
