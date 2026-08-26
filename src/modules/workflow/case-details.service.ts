import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import { personalInjuryCaseDetails } from "../../db/schema/personal-injury-case-details";
import { createModuleLogger } from "../../lib/logging/log";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { deriveFilingEligibility } from "./filing-track";
import { recordAuditEvent } from "../shared/audit.service";
import type { MilestoneProjectionField } from "./patch-exclusions";
import { scheduleRfeReminders } from "./reminder.service";
import { materializeTasksForCase, reresolveDueDates } from "./task-materialization.service";

const log = createModuleLogger("workflow.case-details");

/**
 * Read/write for the two practice-area extension tables.
 *
 * These are not ordinary case fields with a form bolted on. Three of the
 * engine's moving parts read them, so *writing* one has to do more than a
 * `SET`:
 *
 *   1. **Condition fields** decide whether a conditional module exists at all.
 *      Flipping `filingTrack` to `concurrent` must make the concurrent-filing
 *      module's tasks appear, without anyone re-opening the case.
 *   2. **Anchor fields** are what open tasks' due dates are computed *from*.
 *      Recording MMI has to move every mmi_date-anchored task, not just ones
 *      materialized after today.
 *   3. **The RFE pair** is the one window the template can't know in advance —
 *      logging it is what creates the reminders.
 *
 * Putting all three behind the upsert is the point: there is exactly one way to
 * write these tables, so none of the three can be forgotten at a call site.
 *
 * See `.claude/workflows/01-data-model.md §5` for why these tables are narrow,
 * and `02-backend-architecture.md` for each hook.
 */

/**
 * Fields a `Condition` can branch on. Writing one re-runs materialization.
 *
 * Mirrors the `immigrationDetails.*` half of `CONDITION_FIELDS`
 * (workflow-template.validation.ts) — kept as the bare column names because
 * that is what a request body carries.
 */
const IMMIGRATION_CONDITION_FIELDS = [
  "filingTrack",
  "naturalizationTrack",
  "isConditionalResidence",
  "priorityDateIsCurrent",
] as const;

const PI_CONDITION_FIELDS = ["defendantType", "isMinorPlaintiff"] as const;

/**
 * Fields some template step anchors its due date to. Writing one re-resolves
 * open tasks' due dates.
 *
 * These are the columns `due-date-resolver.ts` actually reads — not every date
 * on the table. `priorityDate`, for instance, is displayed and reported on but
 * no step anchors to it, so writing it moves nothing.
 */
const IMMIGRATION_ANCHOR_FIELDS = [
  "eligibilityDate",
  "demandLetterSentDate",
  "serviceCompletedDate",
  "rulingDate",
  // The six milestone projections are deliberately absent: they cannot reach
  // this path at all, since `ImmigrationDetailsPatch` excludes them, and
  // `recordCaseMilestone` re-resolves due dates itself after writing them.
  // Listing them here would be dead code that reads as live.
] as const;

const PI_ANCHOR_FIELDS = [
  "incidentDate",
  "statuteOfLimitationsDate",
  "mmiDate",
  "demandSentDate",
  "defendantAnswerDate",
  "msjFiledDate",
  "mediationScheduledDate",
  "trialDate",
  "verdictDate",
  "fundsReceivedDate",
] as const;

/** The keys whose value the patch actually changes — a no-op write fires no hooks. */
function changedKeys<T extends Record<string, unknown>>(
  before: T | null,
  patch: Partial<T>,
): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // A brand-new row changes everything it sets, by definition.
    if (!before || !Object.is(before[key], value)) changed.add(key);
  }
  return changed;
}

const intersects = (changed: Set<string>, fields: readonly string[]) =>
  fields.some((f) => changed.has(f));

/**
 * The one column on each table that is NOT NULL with no default, so the first
 * write has to carry it.
 *
 * Checked here rather than in the request schema because whether it is required
 * depends on whether the row already exists — which the schema can't see.
 * Without this the insert reaches Postgres and comes back a 500 not-null
 * violation instead of a 400 saying which field is missing.
 */
function requireOnCreate<T>(value: T | null | undefined, field: string, table: string): T {
  if (value === null || value === undefined) {
    throw new BadRequestError(`${field} is required when first recording ${table}`);
  }
  return value;
}

async function assertCaseInOrg(caseId: string, organizationId: string): Promise<void> {
  const [row] = await db
    .select({ id: cases.id, organizationId: cases.organizationId })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);

  if (!row || row.organizationId !== organizationId) {
    throw new NotFoundError(`Case ${caseId} not found`);
  }
}

async function auditDetailsWrite(params: {
  caseId: string;
  organizationId: string;
  actorStaffId: string | null;
  table: string;
  changed: Set<string>;
  created: boolean;
}): Promise<void> {
  const fields = [...params.changed].sort();

  await recordAuditEvent({
    // Deliberately `case.updated` rather than a new action: these are case
    // fields that happen to live in an extension table, and the audit registry
    // is copied byte-identically between the two repos — a new action there
    // costs a synchronised change in both for no gain in what a reader learns.
    // The metadata says which table and which fields.
    action: "case.updated",
    entityType: "case",
    entityId: params.caseId,
    parentEntityType: "case",
    parentEntityId: params.caseId,
    organizationId: params.organizationId,
    actor: params.actorStaffId ? { staffId: params.actorStaffId } : undefined,
    summary: `${params.created ? "Recorded" : "Updated"} ${params.table} (${fields.join(", ")})`,
    metadata: { table: params.table, fields, created: params.created },
  });
}

/**
 * The three hooks, run in the order their effects depend on each other:
 * materialization first (so newly-created tasks exist), then due-date
 * re-resolution (which then covers those new tasks too), then RFE reminders
 * (independent, and `ad_hoc` rather than materialized).
 */
async function runWriteHooks(params: {
  caseId: string;
  changed: Set<string>;
  conditionFields: readonly string[];
  anchorFields: readonly string[];
  rfe?: { issuedDate: string | null; deadline: string | null };
}): Promise<void> {
  const { caseId, changed } = params;

  if (intersects(changed, params.conditionFields)) {
    await materializeTasksForCase(caseId);
    log.action("workflow.rematerialized_on_condition_change", { caseId, fields: [...changed] });
  }

  if (intersects(changed, params.anchorFields)) {
    const updated = await reresolveDueDates(caseId);
    log.action("workflow.due_dates_reresolved", { caseId, updated });
  }

  // Both halves are needed to know the window — logging only the issue date
  // says an RFE arrived, not how long there is to answer it.
  const rfeChanged = changed.has("rfeIssuedDate") || changed.has("rfeDeadline");
  if (rfeChanged && params.rfe?.issuedDate && params.rfe.deadline) {
    await scheduleRfeReminders(caseId, new Date(params.rfe.issuedDate), new Date(params.rfe.deadline));
  }
}

// ── Immigration ────────────────────────────────────────────────────────────

/**
 * What a caller may patch on the immigration extension table.
 *
 * `MilestoneProjectionField` is excluded on purpose — those six dates belong to
 * `recordCaseMilestone`, which writes them alongside the milestone row, the
 * calendar event and the audit entry. See `patch-exclusions.ts`.
 */
export type ImmigrationDetailsPatch = Partial<
  Omit<
    typeof immigrationCaseDetails.$inferInsert,
    "id" | "caseId" | "organizationId" | "createdAt" | "updatedAt" | MilestoneProjectionField
  >
>;

export async function getImmigrationDetails(caseId: string, organizationId: string) {
  await assertCaseInOrg(caseId, organizationId);

  const [row] = await db
    .select()
    .from(immigrationCaseDetails)
    .where(eq(immigrationCaseDetails.caseId, caseId))
    .limit(1);

  // Null, not 404: "this case has no immigration details yet" is the normal
  // state of a case someone hasn't filled the panel in for, and the panel
  // needs to render its empty form rather than an error.
  return row ?? null;
}

/**
 * Fills in `filingTrack` and `preferenceCategory` from the § 1.1 inputs.
 *
 * Returns the patch unchanged in three cases, each for its own reason:
 *
 *   - `filingTrackIsManual` is true, or the patch is turning it on. A person has
 *     taken the field over and the computer stops writing it. (Turning the latch
 *     OFF in the same patch hands it straight back, and the derivation runs.)
 *   - the patch explicitly sets `filingTrack` itself while not touching the
 *     inputs — an explicit write wins over a derived one.
 *   - either input is still unknown. A half-known pair has no answer in the
 *     table, and guessing one is how a case ends up on a track nobody chose.
 *
 * A combination the law does not permit (an LPR petitioning a parent, a sibling,
 * or a married child) also leaves the fields alone: there is no correct track for
 * a petition that cannot be filed, and D8's validation rules are where the user
 * is told so.
 */
export function applyDerivedFilingTrack(
  patch: ImmigrationDetailsPatch,
  existing: typeof immigrationCaseDetails.$inferSelect | null,
): ImmigrationDetailsPatch {
  const isManual = patch.filingTrackIsManual ?? existing?.filingTrackIsManual ?? false;
  if (isManual) return patch;

  const petitionerStatus = patch.petitionerStatus ?? existing?.petitionerStatus ?? null;
  const relationship = patch.relationshipCategory ?? existing?.relationshipCategory ?? null;
  if (!petitionerStatus || !relationship) return patch;

  const touchesInputs =
    patch.petitionerStatus !== undefined || patch.relationshipCategory !== undefined;
  if (patch.filingTrack !== undefined && !touchesInputs) return patch;

  const eligibility = deriveFilingEligibility(petitionerStatus, relationship);
  if (!eligibility.petitionable) return patch;

  return {
    ...patch,
    filingTrack: eligibility.filingTrack,
    preferenceCategory: eligibility.preferenceCategory,
  };
}

export async function upsertImmigrationDetails(params: {
  caseId: string;
  organizationId: string;
  patch: ImmigrationDetailsPatch;
  actorStaffId: string | null;
}) {
  const { caseId, organizationId, patch: rawPatch, actorStaffId } = params;
  await assertCaseInOrg(caseId, organizationId);

  const existing = await getImmigrationDetails(caseId, organizationId);

  // Derivation runs BEFORE `changedKeys`, so a patch that only changes an input
  // still registers the derived fields as changed and fires the condition hook
  // below. Doing it after would compute the right values and then not
  // re-materialize, which is the worse half of both options.
  const patch = applyDerivedFilingTrack(rawPatch, existing);
  const changed = changedKeys(existing, patch);

  if (existing && changed.size === 0) return existing;

  const [saved] = existing
    ? await db
        .update(immigrationCaseDetails)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(immigrationCaseDetails.caseId, caseId))
        .returning()
    : await db
        .insert(immigrationCaseDetails)
        .values({
          ...patch,
          caseId,
          organizationId,
        })
        .returning();

  await auditDetailsWrite({
    caseId,
    organizationId,
    actorStaffId,
    table: "immigration_case_details",
    changed,
    created: !existing,
  });

  await runWriteHooks({
    caseId,
    changed,
    conditionFields: IMMIGRATION_CONDITION_FIELDS,
    anchorFields: IMMIGRATION_ANCHOR_FIELDS,
    rfe: { issuedDate: saved.rfeIssuedDate, deadline: saved.rfeDeadline },
  });

  return saved;
}

// ── Personal injury ────────────────────────────────────────────────────────

export type PersonalInjuryDetailsPatch = Partial<
  Omit<typeof personalInjuryCaseDetails.$inferInsert, "id" | "caseId" | "organizationId" | "createdAt" | "updatedAt">
>;

export async function getPersonalInjuryDetails(caseId: string, organizationId: string) {
  await assertCaseInOrg(caseId, organizationId);

  const [row] = await db
    .select()
    .from(personalInjuryCaseDetails)
    .where(eq(personalInjuryCaseDetails.caseId, caseId))
    .limit(1);

  return row ?? null;
}

export async function upsertPersonalInjuryDetails(params: {
  caseId: string;
  organizationId: string;
  patch: PersonalInjuryDetailsPatch;
  actorStaffId: string | null;
}) {
  const { caseId, organizationId, patch, actorStaffId } = params;
  await assertCaseInOrg(caseId, organizationId);

  const existing = await getPersonalInjuryDetails(caseId, organizationId);
  const changed = changedKeys(existing, patch);

  if (existing && changed.size === 0) return existing;

  const [saved] = existing
    ? await db
        .update(personalInjuryCaseDetails)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(personalInjuryCaseDetails.caseId, caseId))
        .returning()
    : await db
        .insert(personalInjuryCaseDetails)
        .values({
          ...patch,
          caseId,
          organizationId,
          incidentDate: requireOnCreate(patch.incidentDate, "incidentDate", "personal injury details"),
        })
        .returning();

  await auditDetailsWrite({
    caseId,
    organizationId,
    actorStaffId,
    table: "personal_injury_case_details",
    changed,
    created: !existing,
  });

  await runWriteHooks({
    caseId,
    changed,
    conditionFields: PI_CONDITION_FIELDS,
    anchorFields: PI_ANCHOR_FIELDS,
  });

  return saved;
}

/**
 * The field lists, exported for their own test.
 *
 * A column added to either extension table that a condition or anchor reads,
 * but that isn't listed above, produces a silent bug: the write succeeds and
 * nothing re-runs. The test cross-checks these against `CONDITION_FIELDS` and
 * the resolver's anchor switch, so that omission fails a test instead.
 */
export const WRITE_HOOK_FIELDS = {
  immigration: { condition: IMMIGRATION_CONDITION_FIELDS, anchor: IMMIGRATION_ANCHOR_FIELDS },
  personalInjury: { condition: PI_CONDITION_FIELDS, anchor: PI_ANCHOR_FIELDS },
} as const;
