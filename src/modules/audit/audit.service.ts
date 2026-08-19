import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import {
  domainOf,
  labelFor,
  type AuditCategoryName,
} from "../../lib/audit/actions";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("audit.service");

/**
 * The firm-wide audit trail, read back.
 *
 * One endpoint over one table, replacing the per-entity feeds that each had to
 * re-implement filtering, paging and labelling. The per-entity feeds still
 * exist — a lead's activity tab is gated on the lead, not on the audit
 * resource — but they are now the same query with `entityType`/`entityId`
 * pinned, not different code.
 */

/**
 * Keyset, not offset.
 *
 * The trail only grows, and it grows fastest at the end a reader starts from.
 * An `OFFSET 40000` makes Postgres walk and discard 40,000 index entries to
 * return 50; worse, a row inserted mid-scroll shifts every subsequent page by
 * one and the reader silently skips an event. A cursor of
 * `(occurred_at, id)` is a range scan on the index the table already has, and
 * it cannot skip or repeat.
 */
export interface AuditCursor {
  occurredAt: Date;
  id: string;
}

const encodeCursor = (row: { occurredAt: Date; id: string }): string =>
  Buffer.from(`${row.occurredAt.toISOString()}|${row.id}`, "utf8").toString(
    "base64url",
  );

/** Returns null for anything malformed — a bad cursor reads page one, it does not 500. */
export const decodeCursor = (raw: string): AuditCursor | null => {
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const occurredAt = new Date(iso);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
};

export interface ListAuditEventsFilters {
  /** Omit to get the changes feed; pass `"access"` for views and downloads. */
  category?: AuditCategoryName;
  /**
   * Keep view/download rows in an otherwise uncategorised result.
   *
   * Entity feeds want them — "who looked at this matter" belongs beside "who
   * changed it", which is the whole reason the two planes share a table. The
   * firm-wide feed does not: views outnumber changes by orders of magnitude
   * and would bury every state change on page one.
   */
  includeAccess?: boolean;
  /** An exact registry action, e.g. `"lead.stage_changed"`. */
  action?: string;
  /** Everything in one domain — `"lead"` matches every `lead.*` action. */
  domain?: string;
  entityType?: string;
  entityId?: string;
  /** `user.id` of the actor, as stored in `actor_id`. */
  actorId?: string;
  /** `staff.id`, for picking a colleague out of a staff directory. */
  actorStaffId?: string;
  from?: Date;
  to?: Date;
  /** Free text over the stored summary. */
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditEventDTO {
  id: string;
  /** A registry action name, e.g. `"lead.stage_changed"`. */
  action: string;
  /** The registry's label for that action. Render this, do not rebuild it. */
  label: string;
  category: string;
  actionType: string;
  /** The sentence written when the row was recorded. */
  summary: string;
  entityType: string;
  entityId: string | null;
  parentEntityType: string | null;
  parentEntityId: string | null;
  actorType: string;
  actorId: string | null;
  actorStaffId: string | null;
  /** The name as it stood when the event happened, never a live lookup. */
  actorName: string;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
  ipAddress: string | null;
  source: string;
  occurredAt: string;
}

export interface ListAuditEventsResult {
  data: AuditEventDTO[];
  /** Pass back as `cursor` for the next page. Null means this was the last one. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Hard ceiling regardless of what the caller asks for. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const toDTO = (row: typeof auditEvents.$inferSelect): AuditEventDTO => ({
  id: row.id,
  action: row.action,
  label: labelFor(row.action),
  category: row.category,
  actionType: row.actionType,
  summary: row.summary,
  entityType: row.entityType,
  entityId: row.entityId,
  parentEntityType: row.parentEntityType,
  parentEntityId: row.parentEntityId,
  actorType: row.actorType,
  actorId: row.actorId,
  actorStaffId: row.actorStaffId,
  actorName: row.actorName,
  actorEmail: row.actorEmail,
  before: row.before ?? null,
  after: row.after ?? null,
  metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  requestId: row.requestId,
  ipAddress: row.ipAddress,
  source: row.source,
  occurredAt: row.occurredAt.toISOString(),
});

const buildWhere = (
  organizationId: string,
  f: ListAuditEventsFilters,
): SQL => {
  const clauses: SQL[] = [eq(auditEvents.organizationId, organizationId)];

  // Excluded unless asked for. Without this the changes feed is unreadable,
  // and the partial index on `category <> 'access'` never gets used.
  if (f.category) {
    clauses.push(eq(auditEvents.category, f.category));
  } else if (!f.includeAccess) {
    clauses.push(sql`${auditEvents.category} <> 'access'`);
  }

  if (f.action) clauses.push(eq(auditEvents.action, f.action));
  // `LIKE 'lead.%'` rather than a domain column: the prefix is part of the
  // action by construction, and an index on `action` serves a prefix match.
  if (f.domain) clauses.push(sql`${auditEvents.action} LIKE ${`${f.domain}.%`}`);
  if (f.entityType) clauses.push(eq(auditEvents.entityType, f.entityType));
  if (f.entityId) clauses.push(eq(auditEvents.entityId, f.entityId));
  if (f.actorId) clauses.push(eq(auditEvents.actorId, f.actorId));
  if (f.actorStaffId) clauses.push(eq(auditEvents.actorStaffId, f.actorStaffId));
  if (f.from) clauses.push(gte(auditEvents.occurredAt, f.from));
  if (f.to) clauses.push(lte(auditEvents.occurredAt, f.to));
  if (f.search) {
    clauses.push(sql`${auditEvents.summary} ILIKE ${`%${f.search}%`}`);
  }

  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  if (cursor) {
    // Strictly "older than the last row I saw", with `id` breaking ties so two
    // events recorded in the same millisecond cannot straddle a page boundary.
    clauses.push(
      or(
        lt(auditEvents.occurredAt, cursor.occurredAt),
        and(
          eq(auditEvents.occurredAt, cursor.occurredAt),
          lt(auditEvents.id, cursor.id),
        ),
      )!,
    );
  }

  return and(...clauses)!;
};

export class AuditService {
  /** One page of the trail, newest first. */
  listEvents = async (
    organizationId: string,
    filters: ListAuditEventsFilters = {},
  ): Promise<ListAuditEventsResult> => {
    const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // One extra row is the cheapest way to answer "is there a next page"
    // without a second COUNT over the same predicate.
    const rows = await db
      .select()
      .from(auditEvents)
      .where(buildWhere(organizationId, filters))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    log.debug("audit.queried", {
      organizationId,
      returned: page.length,
      hasMore,
    });

    return {
      data: page.map(toDTO),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      hasMore,
    };
  };

  /**
   * Everything matching the filters, for an export.
   *
   * Capped rather than streamed: an unbounded export of a table designed to
   * hold years of history is a way to take the process down, and a firm
   * needing more than this is asking for a data extract, not a CSV.
   */
  exportEvents = async (
    organizationId: string,
    filters: ListAuditEventsFilters = {},
    cap = 10_000,
  ): Promise<AuditEventDTO[]> => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(buildWhere(organizationId, { ...filters, cursor: undefined }))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(cap);

    return rows.map(toDTO);
  };

  /**
   * What this firm's trail actually contains, for populating filter controls.
   *
   * Driven by the data rather than the registry: the registry lists every
   * action the system *can* write, which for most firms is a filter dropdown
   * of 150 entries where 20 have ever occurred.
   */
  getFilterFacets = async (organizationId: string) => {
    const rows = await db
      .select({
        action: auditEvents.action,
        category: auditEvents.category,
        count: sql<number>`count(*)::int`,
      })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId))
      .groupBy(auditEvents.action, auditEvents.category)
      .orderBy(desc(sql`count(*)`));

    const domains = new Map<string, number>();
    for (const row of rows) {
      const domain = domainOf(row.action);
      domains.set(domain, (domains.get(domain) ?? 0) + row.count);
    }

    return {
      actions: rows.map((row) => ({
        action: row.action,
        label: labelFor(row.action),
        category: row.category,
        count: row.count,
      })),
      domains: [...domains.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => b.count - a.count),
      categories: [
        ...rows.reduce((acc, row) => {
          acc.set(row.category, (acc.get(row.category) ?? 0) + row.count);
          return acc;
        }, new Map<string, number>()),
      ].map(([category, count]) => ({ category, count })),
    };
  };

  /**
   * One entity's activity — changes and views together, oldest-last.
   *
   * The per-entity tabs call this instead of each writing their own query.
   * `parentEntityId` is matched as well as `entityId`, so a note recorded
   * against a matter appears on the matter's feed.
   */
  listForEntity = async (
    organizationId: string,
    entityType: string,
    entityId: string,
    filters: Omit<ListAuditEventsFilters, "entityType" | "entityId"> = {},
  ): Promise<ListAuditEventsResult> => {
    const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    // An entity feed shows views alongside changes. An explicit `category`
    // still wins, so a caller can narrow to just the views.
    const base = buildWhere(organizationId, {
      includeAccess: true,
      ...filters,
    });

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          base,
          or(
            and(
              eq(auditEvents.entityType, entityType),
              eq(auditEvents.entityId, entityId),
            ),
            and(
              eq(auditEvents.parentEntityType, entityType),
              eq(auditEvents.parentEntityId, entityId),
            ),
          ),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      data: page.map(toDTO),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      hasMore,
    };
  };

  /**
   * Everything one request did, by correlation id.
   *
   * The single most useful query during an incident: the access log gives you
   * a `requestId`, and this turns it into the list of state changes that one
   * call made.
   */
  listByRequestId = async (
    organizationId: string,
    requestId: string,
  ): Promise<AuditEventDTO[]> => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, organizationId),
          eq(auditEvents.requestId, requestId),
        ),
      )
      .orderBy(auditEvents.occurredAt);

    return rows.map(toDTO);
  };
}

