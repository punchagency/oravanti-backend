/**
 * Who an issue's attorney actions may be assigned to.
 *
 * Kept beside the action registry rather than in the service because it is part
 * of the same question the registry answers — what this action can legally do —
 * and because the dispatch needs it too, not just the endpoint that feeds the
 * picker.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { member, teamMember } from "../../db/schema/auth-schema";
import { cases } from "../../db/schema/cases";
import { staff } from "../../db/schema/staff";

export type EligibleAssignee = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

/**
 * A staff member's role lives in three places depending on how the row was
 * created — better-auth `member.role`, the synced `staff.role` enum, or (for
 * rows predating the sync) `staff.jobTitle`. They disagree in real data, so
 * match any of them, exactly as `OrganizationService.getAll` does. Diverging
 * here would mean the picker and the staff directory disagree about who is an
 * attorney.
 */
const ATTORNEY = "attorney";

const isAttorney = sql`(
  LOWER(${member.role}::text) = ${ATTORNEY}
  OR LOWER(${staff.role}::text) = ${ATTORNEY}
  OR LOWER(${staff.jobTitle}) LIKE ${`%${ATTORNEY}%`}
)`;

/**
 * The matter an assignment is being made against.
 *
 * A case may have a team assigned; a lead never does (there is no team column on
 * `leads`), so lead-stage issues always see the whole firm's attorneys.
 */
export type AssigneeScope = {
  organizationId: string;
  caseId?: string | null;
};

/**
 * Restrict to a case's assigned team, when it has one.
 *
 * Membership lives in better-auth's `team_member`, keyed by `user_id` — not the
 * custom `team_members` table keyed by `staff_id`, which only the CLI seed
 * writes. A consequence of that key: `staff.user_id` is nullable, so a
 * staff member who has not accepted their invitation cannot belong to a team and
 * will not appear here.
 */
const onCaseTeam = (teamId: string) => sql`${staff.userId} IN (
  SELECT ${teamMember.userId} FROM ${teamMember}
  WHERE ${teamMember.teamId} = ${teamId}
)`;

/**
 * Active attorneys who may take work on this matter, ordered by name.
 *
 * Narrowed to the case's team where one is assigned: a firm that has committed a
 * case to a team should not be able to route that case's work outside it.
 */
export const eligibleAssignees = async (
  scope: AssigneeScope,
): Promise<EligibleAssignee[]> => {
  const conditions = [
    eq(staff.organizationId, scope.organizationId),
    eq(staff.status, "active"),
    isAttorney,
  ];

  if (scope.caseId) {
    const [row] = await db
      .select({ teamId: cases.assignedTeamId })
      .from(cases)
      .where(
        and(
          eq(cases.id, scope.caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    if (row?.teamId) conditions.push(onCaseTeam(row.teamId));
  }

  return db
    .select({
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      role: sql<string | null>`COALESCE(${member.role}, ${staff.role}::text)`,
    })
    .from(staff)
    .leftJoin(
      member,
      and(
        eq(member.userId, staff.userId),
        eq(member.organizationId, staff.organizationId),
      ),
    )
    .where(and(...conditions))
    .orderBy(staff.firstName, staff.lastName);
};

/**
 * The assignee an action should use, or a reason it cannot run.
 *
 * A single attorney is chosen for the caller — the firm has no decision to make,
 * so the UI does not have to ask. Resolving it here rather than trusting the
 * client to have skipped the dialog keeps the rule in one place.
 */
export type AssigneeResolution =
  | { ok: true; staffId: string }
  | { ok: false; reason: "none" | "ambiguous" | "ineligible" };

export const resolveAssignee = async (
  scope: AssigneeScope,
  requested: string | undefined,
): Promise<AssigneeResolution> => {
  const eligible = await eligibleAssignees(scope);
  if (eligible.length === 0) return { ok: false, reason: "none" };

  if (!requested) {
    return eligible.length === 1
      ? { ok: true, staffId: eligible[0].id }
      : { ok: false, reason: "ambiguous" };
  }

  // Never trust a submitted id: it decides who gets the work, and no other
  // assignment path in this codebase checks org membership or role.
  return eligible.some((a) => a.id === requested)
    ? { ok: true, staffId: requested }
    : { ok: false, reason: "ineligible" };
};
