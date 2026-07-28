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
import { member } from "../../db/schema/auth-schema";
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
 * Active attorneys in the firm, ordered by name.
 *
 * TODO(ai-review): once the attorney actions are implemented for cases, a case
 * with an `assignedTeamId` must narrow this to that team's members —
 * `cases.assignedTeamId -> team_member.teamId -> staff ON staff.userId =
 * team_member.userId` (the pattern in `OrganizationService.getTeam`). Note the
 * custom `team_members` table keyed by `staffId` is seed-only; `team_member`
 * (better-auth, keyed by `userId`) is the one the app maintains.
 */
export const eligibleAssignees = async (
  organizationId: string,
): Promise<EligibleAssignee[]> =>
  db
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
    .where(
      and(
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        isAttorney,
      ),
    )
    .orderBy(staff.firstName, staff.lastName);

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
  organizationId: string,
  requested: string | undefined,
): Promise<AssigneeResolution> => {
  const eligible = await eligibleAssignees(organizationId);
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
