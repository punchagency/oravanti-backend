import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import postgres from "postgres";
import { auditEvents } from "../../db/schema/audit-events";
import { organization } from "../../db/schema/auth-schema";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("shared.audit-retention");

/**
 * Purging the audit trail past its retention window.
 *
 * Plan-02 step 36, and the one piece of the audit system that deliberately
 * cannot run on the application's own database connection: step 35 revokes
 * `DELETE` on `audit_events` from `oravanti_app`, which is the point of it. The
 * job therefore opens its own connection as `oravanti_maintenance`, a role that
 * may read and delete audit rows and touch almost nothing else.
 *
 * If `MAINTENANCE_DATABASE_URL` is unset the job **does not fall back** to the
 * app connection. A retention job that silently runs with the wrong privileges
 * is worse than one that does not run: it would work today and mask the fact
 * that the immutability grant was never applied.
 *
 * ─── Two windows, because the two planes are not the same record ────────────
 *
 * Changes are the firm's legal record and are kept for years. Views and
 * downloads answer "who looked at this", which matters for a couple of years
 * and then becomes volume — they outnumber changes by one to two orders of
 * magnitude, so they dominate the table long before they dominate its value.
 */

/** Legal-practice defaults. A firm may lengthen these; see `resolveWindow`. */
export const DEFAULT_AUDIT_RETENTION_YEARS = 7;
export const DEFAULT_ACCESS_RETENTION_YEARS = 2;

/**
 * Never purge more than this in one pass.
 *
 * A first run against years of history would otherwise be a single DELETE
 * holding locks for minutes. The job is scheduled often enough that a backlog
 * drains over a few runs, and a bounded statement is one that can be killed
 * without leaving a half-finished transaction.
 */
const MAX_ROWS_PER_PASS = 50_000;

export interface RetentionResult {
  organizationId: string | null;
  auditDeleted: number;
  accessDeleted: number;
}

export interface RetentionSummary {
  organizations: number;
  auditDeleted: number;
  accessDeleted: number;
  /** True when a pass hit the cap, so there is more to remove next time. */
  moreRemaining: boolean;
}

type RetentionDb = ReturnType<typeof drizzle>;

/** The maintenance connection, or null when the role has not been configured. */
export const openMaintenanceConnection = (): {
  db: RetentionDb;
  close: () => Promise<void>;
} | null => {
  const url = process.env.MAINTENANCE_DATABASE_URL;
  if (!url) return null;

  // `max: 1` — this is a background job, not a request path, and one
  // long-running DELETE at a time is exactly the concurrency wanted.
  const client = postgres(url, { max: 1 });
  return { db: drizzle(client), close: () => client.end() };
};

const yearsAgo = (years: number): Date => {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return cutoff;
};

/**
 * A firm's configured window, falling back to the platform default.
 *
 * Read from `organization.metadata`, which better-auth stores as a JSON string,
 * so a firm can lengthen its retention without a schema change. **Only
 * lengthening is honoured**: a firm cannot configure a window shorter than the
 * legal-practice default and quietly destroy records it is required to keep.
 */
export const resolveWindow = (
  metadata: string | null,
  key: "auditRetentionYears" | "accessRetentionYears",
  fallback: number,
): number => {
  if (!metadata) return fallback;

  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = parsed[key];
    const years = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(years) || years <= 0) return fallback;
    return Math.max(years, fallback);
  } catch {
    // Malformed metadata must not shorten anyone's retention.
    return fallback;
  }
};

/**
 * Deletes the oldest rows past `cutoff`, up to the cap.
 *
 * Expressed as `id IN (SELECT … LIMIT n)` because Postgres has no `DELETE …
 * LIMIT`. The subquery rides the `(organization_id, occurred_at)` index, and
 * ordering oldest-first means repeated passes make monotonic progress rather
 * than deleting an arbitrary slice each time.
 */
const deleteBatch = async (
  db: RetentionDb,
  organizationId: string | null,
  cutoff: Date,
  accessOnly: boolean,
): Promise<number> => {
  const scope = organizationId
    ? eq(auditEvents.organizationId, organizationId)
    : sql`${auditEvents.organizationId} IS NULL`;

  const category = accessOnly
    ? eq(auditEvents.category, "access")
    : sql`${auditEvents.category} <> 'access'`;

  const doomed = db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(scope, category, lt(auditEvents.occurredAt, cutoff)))
    .orderBy(auditEvents.occurredAt)
    .limit(MAX_ROWS_PER_PASS);

  const deleted = await db
    .delete(auditEvents)
    .where(inArray(auditEvents.id, doomed))
    .returning({ id: auditEvents.id });

  return deleted.length;
};

/** One firm's pass. Exported so the CLI can target a single organization. */
export const purgeOrganization = async (
  db: RetentionDb,
  organizationId: string | null,
  metadata: string | null,
): Promise<RetentionResult> => {
  const auditYears = resolveWindow(
    metadata,
    "auditRetentionYears",
    DEFAULT_AUDIT_RETENTION_YEARS,
  );
  const accessYears = resolveWindow(
    metadata,
    "accessRetentionYears",
    DEFAULT_ACCESS_RETENTION_YEARS,
  );

  const auditDeleted = await deleteBatch(db, organizationId, yearsAgo(auditYears), false);
  const accessDeleted = await deleteBatch(db, organizationId, yearsAgo(accessYears), true);

  if (auditDeleted || accessDeleted) {
    // `action` rather than `info`: destroying legally-retained records is a
    // thing that happened, not a lifecycle note, and it must be greppable
    // years later against a claim that a record was never written.
    log.action(
      "audit.retention_purged",
      { organizationId, auditDeleted, accessDeleted, auditYears, accessYears },
      `purged ${auditDeleted + accessDeleted} audit rows for ${organizationId ?? "platform"}`,
    );
  }

  return { organizationId, auditDeleted, accessDeleted };
};

/**
 * One retention pass across every firm, plus the org-less platform rows.
 *
 * Those org-less rows are failed sign-ins, where no organization is known until
 * authentication succeeds. They are security records and follow the access
 * window, since that is what they are: evidence of who tried to get in.
 */
export const runAuditRetention = async (): Promise<RetentionSummary | null> => {
  const connection = openMaintenanceConnection();

  if (!connection) {
    log.warn("audit.retention_skipped", {
      reason: "maintenance_role_not_configured",
    });
    return null;
  }

  const { db, close } = connection;

  try {
    const orgs = await db
      .select({ id: organization.id, metadata: organization.metadata })
      .from(organization);

    const results: RetentionResult[] = [];

    for (const org of orgs) {
      results.push(await purgeOrganization(db, org.id, org.metadata));
    }

    // The platform-level rows nobody's organization owns.
    results.push(await purgeOrganization(db, null, null));

    const summary: RetentionSummary = {
      organizations: orgs.length,
      auditDeleted: results.reduce((n, r) => n + r.auditDeleted, 0),
      accessDeleted: results.reduce((n, r) => n + r.accessDeleted, 0),
      moreRemaining: results.some(
        (r) => r.auditDeleted >= MAX_ROWS_PER_PASS || r.accessDeleted >= MAX_ROWS_PER_PASS,
      ),
    };

    log.info(
      "audit.retention_completed",
      { ...summary },
      `retention pass complete: ${summary.auditDeleted + summary.accessDeleted} rows removed`,
    );

    return summary;
  } catch (error) {
    // Never rethrows into the scheduler: a failed purge is a backlog, not an
    // outage, and the next pass picks up where this one stopped.
    log.failure("audit.retention_failed", error);
    return null;
  } finally {
    await close();
  }
};
