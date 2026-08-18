import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
// Type-only, so nothing at runtime links the schema to the vocabulary or to
// the middleware — see the drift guards at the foot of this file.
import type { AuditActionTypeName, AuditCategoryName } from "../../lib/audit/actions";
import type { ActorType, RequestSource } from "../../middleware/request-context";

/**
 * The audit trail: one table for everything that happened.
 *
 * Every row is who did what, to which entity, when, from where — whether that
 * was a change (`before`/`after` populated) or a read (`category: "access"`,
 * both null).
 *
 * ─── Why one table and not two ─────────────────────────────────────────────
 *
 * The design this replaced had `access_events` as a separate table, on the
 * reasoning that view events outnumber writes by one to two orders of
 * magnitude and are kept for two years rather than seven, so a matter's
 * business timeline should not have to pay for view noise.
 *
 * That reasoning did not survive contact with the read paths. Every entity
 * feed in the app wants both — an audit-log tab shows "Ada viewed this file"
 * next to "Ada changed the stage" — so each one immediately `UNION ALL`ed the
 * two tables back together and summed two counts to paginate. The split was
 * being undone on every single read.
 *
 * The three things it was meant to buy are all obtainable without it:
 *
 *   - **Query cost.** A partial index excluding `category = 'access'` gives
 *     the changes-only feed exactly the index it would have had.
 *   - **Retention.** A predicate in the purge job, or a partition boundary.
 *   - **Failure policy.** That belongs to the writer, not the table.
 *     `recordAuditEvent` throws and joins the caller's transaction;
 *     `recordAccessEvent` never throws and deduplicates. They stay two
 *     functions with two signatures — so a view still cannot be filed as a
 *     change — and write one table.
 *
 * This table replaces eleven — `lead_events`, `case_events`,
 * `finance_events`, `step_action_logs`, `task_review_events`,
 * `permission_audit_log`, `lead_timeline_events`, `case_timeline_events`,
 * `workflow_log`, `document_activity_logs` and `case_issue_events` — which
 * between them used seven different actor conventions, six writer functions
 * with three different failure behaviours, and no way to correlate two rows
 * written by the same request.
 *
 * ─── Three properties this schema exists to guarantee ──────────────────────
 *
 * 1. **A trail cannot be deleted by deleting the thing it describes.** There
 *    are NO foreign keys to business entities here — see the note on
 *    `entityId`. Today `lead_events.lead_id`, `case_events.case_id`,
 *    `step_action_logs` and `case_issue_events.issue_id` all cascade, so
 *    removing a lead removes the history of what was done to it.
 *
 * 2. **A row cannot be attributed to the wrong person.** Actor, org, IP,
 *    user-agent and request id are read from the request context by the
 *    writer, never passed by the call site. `actorName` is a snapshot, so
 *    history still reads correctly after the staff member leaves the firm.
 *
 * 3. **A row cannot be changed after the fact.** Nothing in the application
 *    updates or deletes these tables, and from Phase 7 the `oravanti_app`
 *    role holds INSERT and SELECT only — immutability enforced by Postgres
 *    rather than by convention.
 *
 * A plain table. Monthly partitioning on `occurredAt` would make retention a
 * partition drop rather than a mass DELETE, but a partitioned table is not
 * expressible through `db:push`, and retention is an optimisation rather than
 * a correctness property. Convert through the CLI baseline if volume ever
 * justifies it. Retention differs by category — 7+ years for changes, 2 for
 * `access` — which is a predicate in the purge job, not a second table.
 */

/** Mirrors `ActorType` in `middleware/request-context.ts`; kept in step by `audit-events.test.ts`. */
export const auditActorTypeEnum = pgEnum("audit_actor_type", [
  "staff",
  "client",
  "contractor",
  "system",
  "anonymous",
]);

/**
 * What kind of record this is, and therefore who reads it.
 *
 * `business` is the matter timeline a firm and its client see. `security` is
 * the authentication feed alerting reads. `admin` is who changed permissions,
 * staff and firm settings. `system` is automated action with no human actor.
 *
 * `access` is a read — someone opened a file, downloaded a document, ran an
 * export. It is the one category that changes nothing, which is why `before`
 * and `after` are always null on those rows, and why it is the only category
 * excluded from the changes-only feed index below.
 */
export const auditCategoryEnum = pgEnum("audit_category", [
  "business",
  "security",
  "admin",
  "system",
  "access",
]);

/** Mirrors `RequestSource` in `middleware/request-context.ts`. */
export const auditSourceEnum = pgEnum("audit_source", [
  "http",
  "queue",
  "webhook",
  "cli",
  "system",
]);

/** The CRUD verb behind the action, for filtering a feed without knowing the vocabulary. */
export const auditActionTypeEnum = pgEnum("audit_action_type", [
  "create",
  "read",
  "update",
  "delete",
]);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Nullable, which is a deliberate departure from every other table in this
     * schema — and from the first draft of this one.
     *
     * The security events that matter most happen before an organization is
     * known, or when there is no organization to know. A failed login has only
     * an email address and an IP; a rejected contractor registration has no
     * org at all. Requiring an org here would mean either dropping exactly
     * those rows or inventing a sentinel organization to hold them, and
     * unrecorded failed logins is the single largest gap this table exists to
     * close.
     *
     * Org-less rows are platform-level security records. They are invisible to
     * the per-firm feed (every read filters on `organizationId`) and are read
     * by the security feed and alerting instead.
     */
    organizationId: text("organization_id"),

    /**
     * Timezone-aware, unlike all eleven tables this replaces — every one of
     * them used a bare `timestamp`, so the same event read from two regions
     * disagreed about when it happened. For a record that has to be defensible
     * years later, that is not survivable.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    actorType: auditActorTypeEnum("actor_type").notNull(),
    /** `user.id`. Null for system actors and for anonymous requests. */
    actorId: text("actor_id"),
    actorStaffId: uuid("actor_staff_id"),
    /**
     * Snapshot, not a join. The firm's name for this person at the moment they
     * acted — so the trail still reads correctly after the staff record is
     * deleted, and so reading a feed costs no lookup per row. Never null: the
     * writer falls back through staff name, account name, email, and finally
     * the actor-type sentinel, because a null here is indistinguishable from a
     * deleted account.
     */
    actorName: text("actor_name").notNull(),
    actorEmail: text("actor_email"),

    category: auditCategoryEnum("category").notNull(),
    /**
     * The action name from the registry — `lead.stage_changed`,
     * `auth.login_failed`. Stored as text rather than a pgEnum on purpose:
     * Postgres cannot use an enum value in the same transaction that adds it,
     * so an enum would make every new auditable action a two-migration change.
     * The closed vocabulary is enforced in TypeScript by `lib/audit/actions.ts`
     * instead, which the frontend imports — so labels cannot drift from the
     * backend either.
     */
    action: text("action").notNull(),
    actionType: auditActionTypeEnum("action_type").notNull(),

    /**
     * NO FOREIGN KEYS. `entityId` is a plain identifier, not a reference.
     *
     * This is the point of the table. A foreign key with `cascade` deletes the
     * trail along with the row — the current bug in `lead_events`,
     * `case_events`, `step_action_logs` and `case_issue_events`. A foreign key
     * with `restrict` is worse: it makes the audit trail block ordinary
     * deletion. `finance_events` reaches for the right answer with `set null`,
     * which keeps the row but loses which entity it described. Storing the id
     * as plain text keeps both the row and its subject, permanently.
     */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** The matter or lead a nested entity belongs to, so a case feed can pick up its steps and notes. */
    parentEntityType: text("parent_entity_type"),
    parentEntityId: text("parent_entity_id"),

    /**
     * Human-readable sentence, rendered at write time.
     *
     * Rendered here rather than at read time because it has to describe what
     * happened using the vocabulary in force when it happened. A summary
     * rebuilt years later from current code would silently re-describe history.
     */
    summary: text("summary").notNull(),

    /**
     * The changed fields only, never whole rows. Both pass through the logging
     * redactor before insert, so key material and credentials cannot reach a
     * table nothing is allowed to delete from.
     */
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata").notNull().default({}),

    /**
     * Ties this row to the HTTP access log line, every diagnostic line, and the
     * OpenTelemetry trace for the same user action. Nothing in the eleven
     * tables this replaces had any equivalent, so two rows written by one
     * request could not be linked.
     */
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    source: auditSourceEnum("source").notNull(),
  },
  (table) => [
    /**
     * The org-wide changes feed, and the index that does not exist today —
     * `lead_events` indexes only `(lead_id, created_at)`.
     *
     * Partial, excluding reads. This is what makes one table as cheap as two
     * for the query that motivated splitting them: views are the high-volume
     * category, and the firm-wide activity feed does not want them.
     */
    index("audit_events_org_occurred_at_idx")
      .on(table.organizationId, table.occurredAt.desc())
      .where(sql`category <> 'access'`),
    /** One entity's history — the case timeline, the lead timeline, the document trail. Reads included: a feed for a single entity wants them. */
    index("audit_events_entity_idx").on(
      table.organizationId,
      table.entityType,
      table.entityId,
      table.occurredAt.desc(),
    ),
    /** "What did this person do?" — the staff activity view that is a stub today. */
    index("audit_events_actor_idx").on(table.organizationId, table.actorId, table.occurredAt.desc()),
    /** The security and admin feeds, and what alerting reads. */
    index("audit_events_category_idx").on(
      table.organizationId,
      table.category,
      table.occurredAt.desc(),
    ),
    /** Everything one request did — the join back to the application logs. */
    index("audit_events_request_idx").on(table.requestId),
    /** Rolls up a case feed that includes its steps, notes and documents in one scan. */
    index("audit_events_parent_idx").on(
      table.organizationId,
      table.parentEntityType,
      table.parentEntityId,
      table.occurredAt.desc(),
    ),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

export type AuditCategory = (typeof auditCategoryEnum.enumValues)[number];
export type AuditActionType = (typeof auditActionTypeEnum.enumValues)[number];
export type AuditActorTypeValue = (typeof auditActorTypeEnum.enumValues)[number];
export type AuditSourceValue = (typeof auditSourceEnum.enumValues)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Drift guards
// ─────────────────────────────────────────────────────────────────────────────
//
// Four columns here are filled by copying a value straight through from
// somewhere else: `category` and `action_type` from the action registry,
// `actor_type` and `source` from the request context. If either side grows a
// value the other does not have, nothing fails until a real insert hits a
// Postgres enum that has never heard of it — in production, on the one row
// that most needed writing.
//
// These assertions turn that into a compile error. They are checked by
// `npm run typecheck`; note that `__tests__` is outside the tsconfig include,
// so a type-level guard in a test file would not be checked at all, which is
// why they live here. `audit-events.test.ts` re-checks the same thing at
// runtime, which additionally catches an edit to the enum literals below.

/** `true` when the two unions are the same set, `never` otherwise — so assigning `true` fails. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _categoryMatchesRegistry: Exact<AuditCategory, AuditCategoryName> = true;
const _actionTypeMatchesRegistry: Exact<AuditActionType, AuditActionTypeName> = true;
const _actorTypeMatchesContext: Exact<AuditActorTypeValue, ActorType> = true;
const _sourceMatchesContext: Exact<AuditSourceValue, RequestSource> = true;

// Referenced so the guards are not mistaken for dead code and deleted.
export const __auditSchemaGuards = [
  _categoryMatchesRegistry,
  _actionTypeMatchesRegistry,
  _actorTypeMatchesContext,
  _sourceMatchesContext,
] as const;
