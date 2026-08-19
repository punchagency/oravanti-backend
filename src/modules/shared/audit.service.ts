import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import {
  ACCESS_ACTIONS,
  AUDIT_ACTIONS,
  type AccessActionName,
  type AuditActionName,
} from "../../lib/audit/actions";
import { deepRedact } from "../../lib/logging/redact";
import { createModuleLogger } from "../../lib/logging/log";
import { getRequestContext, type ActorType } from "../../middleware/request-context";

/**
 * The one writer for the audit trail.
 *
 * Everything a row needs about *who* — actor, organisation, IP, user-agent,
 * request id, source — is read from the request context here, so a call site
 * passes only what is domain-specific. That is not a convenience: the eleven
 * tables this replaces each took the actor as an argument, and between them
 * used seven different conventions for it, which is how rows ended up
 * attributed to nobody, to the wrong person, or to a staff id in a column
 * documented as a user id.
 *
 * ─── Failure policy ────────────────────────────────────────────────────────
 *
 * Audit writes **throw by default**. For a legal record that is the only
 * defensible semantic: either the change and the row that describes it both
 * land, or neither does. Today the answer depends on which table you happened
 * to write to — `logLeadEvent`, `logCaseEvent`, `logFinanceEvent` and
 * `logStepAction` throw; `recordTaskReviewEvent` and the view loggers
 * swallow; `logPermissionChange` throws but four of its six call sites catch
 * and discard.
 *
 * ─── Joining the caller's transaction ──────────────────────────────────────
 *
 * This writer uses the `db` proxy, which routes through the active
 * transaction when there is one — but "active" means registered in the
 * transaction AsyncLocalStorage, which only `withTransaction()` and
 * `runInTransaction()` do. A caller inside a bare `db.transaction(async (tx)
 * => ...)` has no such registration, so `getTx()` returns null and the audit
 * insert goes to the tenant connection **outside** that transaction: a
 * rollback of the business change would leave the audit row behind, claiming
 * something happened that did not.
 *
 * There are 31 bare `db.transaction(` call sites and 26 `withTransaction(`
 * ones, so this is not a hypothetical. **A mutation that must be atomic with
 * its audit row has to run under `withTransaction`.** Convert the bare call
 * sites one module at a time, as you touch them, rather than as a blanket
 * find-and-replace here.
 *
 * The exception is a record of something that already happened outside our
 * control and cannot be rolled back — a rejected sign-in, say. There is no
 * business change to undo, and throwing would turn an unreachable audit table
 * into a 500 on the login endpoint. Those call sites pass
 * `onWriteFailure: "log"`, which is deliberately explicit rather than
 * inferred, so the choice is visible in review.
 *
 * `recordAccessEvent` never throws at all: a view is not a change, and losing
 * the note that someone opened a page must not fail the page. It writes the
 * same table with `category: "access"` — the two functions exist to keep the
 * failure policies and the action vocabularies apart, not because the storage
 * differs.
 *
 * ─── Awaiting is not optional ──────────────────────────────────────────────
 *
 * Both writers must be awaited inside the request. The tenant connection the
 * `db` proxy resolves to is closed on `res.on("finish")`
 * (`middleware/request-context.ts`), so a floating promise races the response
 * and loses. Work that genuinely outlives a request belongs in a queue job,
 * which gets its own context via `runWithRequestContext`.
 */

const log = createModuleLogger("audit");

/** Never null in the database, so the writer always has something to fall back to. */
const ACTOR_NAME_FALLBACK: Record<ActorType, string> = {
  staff: "Unknown staff member",
  client: "Unknown client",
  contractor: "Unknown contractor",
  system: "System",
  anonymous: "Anonymous",
};

/** Matches the window the per-table view loggers used before this writer absorbed them. */
const DEFAULT_ACCESS_DEDUPE_MS = 5 * 60 * 1000;

/**
 * Who acted, when the request context cannot say.
 *
 * Needed for authentication: at sign-in there is no session yet, so
 * `resolveActorContext` has not run and the context holds no user. The auth
 * service knows the email that was tried and, on success, the user it
 * resolved to. Without this, the events that matter most would be the ones
 * recorded with no actor.
 */
export interface AuditActorOverride {
  type?: ActorType;
  /** `user.id`. */
  id?: string | null;
  staffId?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface RecordAuditEventInput {
  /** From `AUDIT_ACTIONS`. Its category, CRUD verb and default entity type come with it and cannot be overridden. */
  action: AuditActionName;
  entityId?: string | null;
  /** Overrides the registry default, for an action that legitimately applies to more than one kind of entity. */
  entityType?: string;
  /** The matter or lead a nested entity hangs off, so a case feed picks up its steps and notes in one query. */
  parentEntityType?: string | null;
  parentEntityId?: string | null;
  /**
   * One sentence describing what happened, in the vocabulary in force now.
   * Defaults to the registry label. Worth writing properly — this is what a
   * reader sees years later, and it cannot be regenerated from current code
   * without re-describing history.
   */
  summary?: string;
  /** The changed fields only, never a whole row. Redacted before insert. */
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Only when the context cannot know it — a webhook, or a sign-in before the session exists. */
  organizationId?: string | null;
  actor?: AuditActorOverride;
  /** For an event being recorded after the fact; defaults to now. */
  occurredAt?: Date;
  /**
   * `"throw"` (default) rolls the caller's transaction back with the failed
   * insert. `"log"` records `audit.write_failed` and continues — only for
   * events describing something already committed elsewhere.
   */
  onWriteFailure?: "throw" | "log";
}

export interface RecordAccessEventInput {
  action: AccessActionName;
  entityId?: string | null;
  entityType?: string;
  parentEntityType?: string | null;
  parentEntityId?: string | null;
  summary?: string;
  metadata?: Record<string, unknown>;
  organizationId?: string | null;
  actor?: AuditActorOverride;
  /**
   * Collapses repeat views by the same actor of the same entity inside the
   * window — tab switches, re-renders and polling would otherwise bury the
   * meaningful access patterns this table exists to show. Pass 0 for an event
   * where every occurrence matters, such as a download or an export.
   */
  dedupeWindowMs?: number;
}

/** The identity columns, resolved once and shared by both tables. */
function resolveActor(override?: AuditActorOverride) {
  const ctx = getRequestContext();

  const actorType = override?.type ?? ctx.actorType;
  const actorId = override?.id !== undefined ? override.id : ctx.userId;
  const actorStaffId = override?.staffId !== undefined ? override.staffId : ctx.staffId;

  return {
    actorType,
    actorId,
    actorStaffId,
    /**
     * Falls through name, then email, then a sentinel for the actor type. A
     * null here would be indistinguishable from a deleted account, which is
     * the ambiguity the snapshot exists to prevent.
     */
    actorName:
      override?.name?.trim() ||
      ctx.actorName?.trim() ||
      override?.email?.trim() ||
      ACTOR_NAME_FALLBACK[actorType],
    actorEmail: override?.email ?? null,
    requestId: ctx.requestId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    source: ctx.source,
    contextOrganizationId: ctx.organizationId,
  };
}

/**
 * Runs the same redaction the log stream uses.
 *
 * A `before`/`after` pair is assembled from live entity fields, so a careless
 * call site can put a password hash or a wrapped key into it. These rows are
 * kept for seven years and nothing is permitted to delete from the table, so
 * a leak here is markedly worse than the same leak in a log line that rotates
 * away in thirty days.
 */
function scrub(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return deepRedact(value);
}

function scrubMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return (deepRedact(value) ?? {}) as Record<string, unknown>;
}

/**
 * Record a change to the audit trail.
 *
 * @throws if the insert fails and `onWriteFailure` is `"throw"` (the default),
 *   taking the caller's transaction down with it.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  const definition = AUDIT_ACTIONS[input.action];
  const actor = resolveActor(input.actor);

  try {
    await db.insert(auditEvents).values({
      organizationId:
        input.organizationId !== undefined
          ? input.organizationId
          : actor.contextOrganizationId,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),

      actorType: actor.actorType,
      actorId: actor.actorId,
      actorStaffId: actor.actorStaffId,
      actorName: actor.actorName,
      actorEmail: actor.actorEmail,

      // Taken from the registry, never from the caller — this is what stops
      // the same action being filed under two categories in two places.
      category: definition.category,
      action: input.action,
      actionType: definition.actionType,

      entityType: input.entityType ?? definition.entityType,
      entityId: input.entityId ?? null,
      parentEntityType: input.parentEntityType ?? null,
      parentEntityId: input.parentEntityId ?? null,

      summary: input.summary ?? definition.label,
      before: scrub(input.before),
      after: scrub(input.after),
      metadata: scrubMetadata(input.metadata),

      requestId: actor.requestId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      source: actor.source,
    });
  } catch (error) {
    if (input.onWriteFailure !== "log") throw error;

    // The event is lost. Say so loudly and with enough of the row to
    // reconstruct it by hand — this is a hole in a record the firm is
    // required to keep, not a routine write failure.
    log.failure("audit.write_failed", error, {
      auditAction: input.action,
      category: definition.category,
      entityType: input.entityType ?? definition.entityType,
      entityId: input.entityId ?? null,
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
      organizationId: input.organizationId ?? actor.contextOrganizationId,
    });
  }
}

/**
 * Has this actor already been recorded viewing this entity inside the window?
 *
 * One indexed lookup on `audit_events_actor_idx`. The alternative — writing
 * every view — makes the table an order of magnitude larger for no extra
 * information, since a page that polls produces a row a second.
 */
async function seenRecently(
  organizationId: string | null,
  action: AccessActionName,
  entityId: string | null,
  actorId: string | null,
  windowMs: number,
): Promise<boolean> {
  // Without an actor there is nothing to deduplicate against — two anonymous
  // views are not known to be the same person, and collapsing them would
  // discard real access history.
  if (!actorId || !entityId || windowMs <= 0) return false;

  const cutoff = new Date(Date.now() - windowMs);

  const [recent] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        organizationId ? eq(auditEvents.organizationId, organizationId) : undefined,
        eq(auditEvents.action, action),
        eq(auditEvents.entityId, entityId),
        eq(auditEvents.actorId, actorId),
        gt(auditEvents.occurredAt, cutoff),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(1);

  return Boolean(recent);
}

/**
 * Record that something was looked at.
 *
 * Never throws. A read is not a change, so there is no transaction to protect
 * and nothing to roll back — failing the page because the note about it could
 * not be filed would be strictly worse than losing the note.
 */
export async function recordAccessEvent(input: RecordAccessEventInput): Promise<void> {
  const definition = ACCESS_ACTIONS[input.action];
  const actor = resolveActor(input.actor);
  const organizationId =
    input.organizationId !== undefined ? input.organizationId : actor.contextOrganizationId;

  try {
    const suppressed = await seenRecently(
      organizationId,
      input.action,
      input.entityId ?? null,
      actor.actorId,
      input.dedupeWindowMs ?? DEFAULT_ACCESS_DEDUPE_MS,
    );
    if (suppressed) return;

    await db.insert(auditEvents).values({
      organizationId,

      actorType: actor.actorType,
      actorId: actor.actorId,
      actorStaffId: actor.actorStaffId,
      actorName: actor.actorName,
      actorEmail: actor.actorEmail,

      // Fixed for every entry in `ACCESS_ACTIONS`, which is why the registry
      // does not repeat them. `before`/`after` stay null: a read changes
      // nothing, so there is no before and no after to record.
      category: "access",
      actionType: "read",
      action: input.action,
      entityType: input.entityType ?? definition.entityType,
      entityId: input.entityId ?? null,
      parentEntityType: input.parentEntityType ?? null,
      parentEntityId: input.parentEntityId ?? null,

      summary: input.summary ?? definition.label,
      metadata: scrubMetadata(input.metadata),

      requestId: actor.requestId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      source: actor.source,
    });
  } catch (error) {
    log.failure("audit.access_write_failed", error, {
      accessAction: input.action,
      entityId: input.entityId ?? null,
      actorId: actor.actorId,
      organizationId,
    });
  }
}
