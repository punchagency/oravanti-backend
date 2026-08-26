import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { member, teamMember } from "../../db/schema/auth-schema";
import { cases, certifications } from "../../db/schema/cases";
import { leaveRequests } from "../../db/schema/leave-requests";
import { staff } from "../../db/schema/staff";
import { staffCertifications } from "../../db/schema/staff-certifications";
import { tasks } from "../../db/schema/tasks";

/**
 * Unified staff-assignment picker: cert-filtered, leave-aware, load-balanced and
 * recency-tiebroken, over whichever pool the caller's scope allows.
 *
 * Team membership is better-auth's `team_member` (keyed by `staff.userId`), not
 * the custom `team_members` table (keyed by `staff.id`, written only by the CLI
 * seed) — matching `case-review/assignees.ts`'s already-correct choice, not the
 * `team_members` guess in the original design doc.
 */

/**
 * Picks whoever on the **case's team** should hold this step.
 *
 * Strictly the team, with no firm-wide fallback: a firm that has committed a
 * matter to a team should not have that matter's work quietly routed outside it,
 * and a step nobody on the team can take is better left unassigned for a person
 * to hand out deliberately. Workflow generation refuses to run at all until a
 * case has a team (see `materializeTasksForCase`), so `teamId` is not optional
 * here — a case without one has no workflow to assign.
 */
export async function pickBestAssignee(params: {
  organizationId: string;
  teamId: string;
  requiredCertifications: string[];
  assignableRoles: string[];
  /** Excluded from the candidate pool — e.g. the person who just completed the prior step, when auto-assigning the next one in sequence. */
  excludeStaffId?: string;
}): Promise<string | null> {
  return pick(params, params.teamId);
}

/**
 * The same picker over the whole firm.
 *
 * Intake pipeline steps hang off a lead, which has no case row and therefore no
 * team to scope by — but everything else about choosing a person is identical:
 * match the role, prefer active staff, skip anyone on approved leave, balance by
 * open workload, break ties by who was assigned longest ago.
 *
 * Split out rather than making the team optional so neither caller can silently
 * pass the wrong thing: a case-scoped call still *must* name its team, and a
 * lead-scoped one cannot pretend to have one.
 */
export async function pickAssigneeForRoles(params: {
  organizationId: string;
  requiredCertifications: string[];
  assignableRoles: string[];
  excludeStaffId?: string;
}): Promise<string | null> {
  return pick(params, null);
}

async function pick(
  params: {
    organizationId: string;
    requiredCertifications: string[];
    assignableRoles: string[];
    excludeStaffId?: string;
  },
  teamId: string | null,
): Promise<string | null> {
  let candidates = await eligibleCandidates(params, teamId);
  if (params.excludeStaffId) candidates = candidates.filter((c) => c.id !== params.excludeStaffId);
  if (candidates.length === 0) return null;

  return pickBestStaff(params.organizationId, candidates);
}

/**
 * Everyone a task may be handed to, for the manual picker.
 *
 * The same pool the auto-assigner draws from, minus the role filter — a person
 * making a deliberate choice may pick anyone on the matter's team, not only
 * whoever the template step nominated. Passing no team returns the whole firm,
 * which is what an intake step or an ad-hoc to-do gets.
 */
export async function assignableStaff(params: {
  organizationId: string;
  teamId: string | null;
}): Promise<{ id: string; name: string; role: string | null }[]> {
  const rows = await eligibleCandidates(
    { organizationId: params.organizationId, requiredCertifications: [], assignableRoles: [] },
    params.teamId,
  );
  return rows
    .map((r) => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      role: r.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The team a case is committed to, or null when it has none yet. */
export async function getCaseTeamId(
  organizationId: string,
  caseId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ teamId: cases.assignedTeamId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  return row?.teamId ?? null;
}

const onTeam = (teamId: string) => sql`${staff.userId} IN (
  SELECT ${teamMember.userId} FROM ${teamMember} WHERE ${teamMember.teamId} = ${teamId}
)`;

/** Any of `roles` matches `member.role`, `staff.role`, or a substring of `staff.jobTitle` — mirrors `case-review/assignees.ts`'s already-established role-matching convention, generalized past its hardcoded "attorney". */
const hasAnyRole = (roles: string[]) => {
  const lowered = roles.map((r) => r.toLowerCase());
  return sql`(
    LOWER(${member.role}::text) IN ${lowered}
    OR LOWER(${staff.role}::text) IN ${lowered}
    OR ${sql.join(
      lowered.map((r) => sql`LOWER(${staff.jobTitle}) LIKE ${`%${r}%`}`),
      sql` OR `,
    )}
  )`;
};

async function eligibleCandidates(
  params: { organizationId: string; requiredCertifications: string[]; assignableRoles: string[] },
  teamId: string | null,
): Promise<{ id: string; firstName: string; lastName: string; role: string | null }[]> {
  const base = [eq(staff.organizationId, params.organizationId)];
  if (params.assignableRoles.length > 0) base.push(hasAnyRole(params.assignableRoles));
  if (teamId) base.push(onTeam(teamId));

  const queryWith = (statusCondition: ReturnType<typeof eq> | ReturnType<typeof ne>) =>
    db
      .select({
        id: staff.id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        role: sql<string | null>`COALESCE(${member.role}, ${staff.role}::text)`,
      })
      .from(staff)
      .leftJoin(member, and(eq(member.userId, staff.userId), eq(member.organizationId, staff.organizationId)))
      .where(and(...base, statusCondition));

  let rows = await queryWith(eq(staff.status, "active"));
  // Degraded fallback, matching the old `pickBestStaff`: nobody strictly
  // "active" beats nobody at all — on-leave/recertify/pending-invitation staff
  // are still better than an unassigned task.
  if (rows.length === 0) rows = await queryWith(ne(staff.status, "inactive"));

  if (params.requiredCertifications.length > 0 && rows.length > 0) {
    const certifiedStaffIds = await db
      .select({ staffId: staffCertifications.staffId, certName: certifications.name })
      .from(staffCertifications)
      .innerJoin(certifications, eq(certifications.id, staffCertifications.certificationId))
      .where(inArray(staffCertifications.staffId, rows.map((r) => r.id)));

    const certsByStaff = new Map<string, Set<string>>();
    for (const row of certifiedStaffIds) {
      const set = certsByStaff.get(row.staffId) ?? new Set();
      set.add(row.certName);
      certsByStaff.set(row.staffId, set);
    }
    const required = new Set(params.requiredCertifications);
    rows = rows.filter((r) => {
      const held = certsByStaff.get(r.id) ?? new Set();
      return [...required].every((c) => held.has(c));
    });
  }

  return rows;
}

/** Leave-aware, load-balanced, recency-tiebroken selection over an already-filtered candidate pool. */
async function pickBestStaff(
  organizationId: string,
  candidates: { id: string }[],
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;

  const todayStr = new Date().toISOString().split("T")[0];
  const staffOnLeave = await db
    .select({ staffId: leaveRequests.staffId })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.organizationId, organizationId),
        eq(leaveRequests.status, "approved"),
        sql`${leaveRequests.startDate} <= ${todayStr}`,
        sql`${leaveRequests.endDate} >= ${todayStr}`,
      ),
    );
  const leaveSet = new Set(staffOnLeave.map((r) => r.staffId));
  const available = candidates.filter((c) => !leaveSet.has(c.id));
  const pool = available.length > 0 ? available : candidates;

  const staffIds = pool.map((c) => c.id);
  const loadRows = await db
    .select({ staffId: tasks.assignedToId, taskCount: count() })
    .from(tasks)
    /*
      `pending` counts as load. It is assigned work someone is carrying — they
      simply have not pressed Start yet. Counting only started tasks would read
      every queue as empty right after materialization and pile the next matter
      onto whoever was already buried.
    */
    .where(
      and(
        inArray(tasks.assignedToId, staffIds),
        inArray(tasks.status, ["pending", "in_progress", "in_review"]),
      ),
    )
    .groupBy(tasks.assignedToId);
  const loadMap = new Map<string, number>();
  for (const row of loadRows) if (row.staffId) loadMap.set(row.staffId, row.taskCount);

  const recentRows = await db
    .select({ staffId: tasks.assignedToId, lastAssigned: sql<string>`MAX(${tasks.assignedAt})`.as("last_assigned") })
    .from(tasks)
    .where(and(inArray(tasks.assignedToId, staffIds), sql`${tasks.assignedAt} IS NOT NULL`))
    .groupBy(tasks.assignedToId);
  const lastAssignedMap = new Map<string, Date>();
  for (const row of recentRows) if (row.staffId) lastAssignedMap.set(row.staffId, new Date(row.lastAssigned));

  const scored = pool.map((c) => ({
    id: c.id,
    load: loadMap.get(c.id) ?? 0,
    lastAssigned: lastAssignedMap.get(c.id) ?? null,
  }));

  scored.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    if (a.lastAssigned && b.lastAssigned) return a.lastAssigned.getTime() - b.lastAssigned.getTime();
    if (!a.lastAssigned && b.lastAssigned) return -1;
    if (a.lastAssigned && !b.lastAssigned) return 1;
    return 0;
  });

  return scored[0].id;
}
