import { and, count, countDistinct, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { aiScanJobs } from "../../db/schema/ai-scan-jobs";
import { aiSystemConfig } from "../../db/schema/ai-system-config";
import {
  caseIssueDocuments,
  caseIssueEvents,
  caseIssues,
} from "../../db/schema/case-issues";
import { cases } from "../../db/schema/cases";
import { clients } from "../../db/schema/clients";
import { scenarioDocumentRequirements } from "../../db/schema/document-requirements";
import {
  documents,
  documentVersions,
  externalSubmissions,
} from "../../db/schema/documents";
import { leads } from "../../db/schema/leads";
import { staff } from "../../db/schema/staff";
import { NotFoundError } from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
import { actionLabel, actionsFor } from "./actions";
import { issueCategory, renderIssue, severityBadge } from "./render";

const CRITICAL_SEVERITIES = ["critical", "high"] as const;
const WARNING_SEVERITIES = ["medium", "low"] as const;
const ACTIVE_STATUSES = ["open", "under_review"] as const;

type IssueRow = typeof caseIssues.$inferSelect;

/** Extra columns the issue queries join in for presentation. */
type IssueJoins = {
  clientName?: string | null;
  caseTypeId?: string | null;
  caseTypeName?: string | null;
  caseNumber?: string | null;
  leadName?: string | null;
};

/**
 * The matter an issue belongs to. `reference` is what the dashboard prints
 * beside the client name — a case number for cases, and the lead's own name for
 * leads, which have no case number until they convert.
 */
const scenarioOf = (row: Pick<IssueRow, "leadId" | "caseId"> & IssueJoins) =>
  row.leadId
    ? {
        type: "lead" as const,
        id: row.leadId,
        reference: row.leadName ?? null,
      }
    : {
        type: "case" as const,
        id: row.caseId!,
        reference: row.caseNumber ?? null,
      };

/**
 * Columns every issue query selects. Shared so the list and detail endpoints
 * cannot drift apart in what they present.
 *
 * The joins these depend on are applied by `withIssueJoins`.
 */
const ISSUE_SELECT = {
  issue: caseIssues,
  clientName: clients.displayName,
  caseTypeId: cases.caseTypeId,
  caseTypeName: practiceAreaCaseTypes.name,
  caseNumber: cases.caseNumber,
  leadName: sql<string | null>`concat(${leads.firstName}, ' ', ${leads.lastName})`,
};

type IssueSelectRow = {
  issue: IssueRow;
  clientName: string | null;
  caseTypeId: string | null;
  caseTypeName: string | null;
  caseNumber: string | null;
  leadName: string | null;
};

const flattenIssueRow = (r: IssueSelectRow): IssueRow & IssueJoins => ({
  ...r.issue,
  clientName: r.clientName,
  caseTypeId: r.caseTypeId,
  caseTypeName: r.caseTypeName,
  caseNumber: r.caseNumber,
  leadName: r.leadName,
});

type MatterRow = {
  id: string;
  type: "case" | "lead";
  name: string;
  reference: string | null;
  critical: number;
  warnings: number;
};

type DocumentFlagRow = {
  document_id: string | null;
  issue_id: string | null;
  title: string;
  type: string | null;
  issue_type: string;
  severity: string;
  matter_name: string;
  matter_reference: string | null;
  matter_id: string;
  matter_type: "case" | "lead";
  source: "client_upload" | "pending_client" | "firm";
  date: string | null;
};

/** "Aisha Patel" → "AP", for the avatar chip on the by-case list. */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

const presentIssue = (row: IssueRow & IssueJoins, language: string) => {
  const prose = renderIssue(
    row.templateKey,
    (row.templateParams as Record<string, unknown>) ?? {},
    language,
  );
  return {
    id: row.id,
    issueType: row.issueType,
    category: issueCategory(row.issueType),
    source: row.source,
    severity: row.severity,
    badge: severityBadge(row.severity),
    status: row.status,
    ...prose,
    affectedField: row.affectedField,
    actions: actionsFor(row.issueType),
    scenario: scenarioOf(row),
    client: row.clientId ? { id: row.clientId, name: row.clientName ?? "" } : null,
    caseTypeId: row.caseTypeId ?? null,
    caseTypeName: row.caseTypeName ?? null,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    dismissedAt: row.dismissedAt,
    createdAt: row.createdAt,
  };
};

export class CaseReviewService {
  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats = async (organizationId: string) => {
    const orgMatch = eq(caseIssues.organizationId, organizationId);
    const active = and(orgMatch, inArray(caseIssues.status, [...ACTIVE_STATUSES]));

    const [critical] = await db
      .select({ n: count() })
      .from(caseIssues)
      .where(and(active, inArray(caseIssues.severity, [...CRITICAL_SEVERITIES])));
    const [warnings] = await db
      .select({ n: count() })
      .from(caseIssues)
      .where(and(active, inArray(caseIssues.severity, [...WARNING_SEVERITIES])));
    // Distinct affected matters (lead or case) among active issues.
    const [affected] = await db
      .select({
        n: countDistinct(sql`coalesce(${caseIssues.caseId}, ${caseIssues.leadId})`),
      })
      .from(caseIssues)
      .where(active);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [resolved] = await db
      .select({ n: count() })
      .from(caseIssues)
      .where(
        and(
          orgMatch,
          eq(caseIssues.status, "resolved"),
          gte(caseIssues.resolvedAt, thirtyDaysAgo),
        ),
      );

    // Every active matter, whether or not it has issues — the denominator in
    // "5 of 22 active matters".
    const [activeCases] = await db
      .select({ n: count() })
      .from(cases)
      .where(and(eq(cases.organizationId, organizationId), eq(cases.status, "active")));

    return {
      criticalIssues: critical.n,
      warnings: warnings.n,
      mattersAffected: affected.n,
      resolvedLast30Days: resolved.n,
      totalActiveMatters: activeCases.n,
      lastScan: await this.lastScanSummary(organizationId),
    };
  };

  /**
   * The "Last scan: … · N matters reviewed · N issues found · N resolved since"
   * strip above the tiles.
   *
   * A full scan fans out into one job per matter, so the run is identified by
   * the `batchId` they share. Falls back to the single most recent completed
   * job when no batch has run yet (a firm whose only scans came from uploads),
   * in which case the counts describe that one job.
   */
  private lastScanSummary = async (organizationId: string) => {
    const [latest] = await db
      .select({
        batchId: aiScanJobs.batchId,
        completedAt: aiScanJobs.completedAt,
      })
      .from(aiScanJobs)
      .where(
        and(
          eq(aiScanJobs.organizationId, organizationId),
          eq(aiScanJobs.status, "complete"),
        ),
      )
      .orderBy(desc(aiScanJobs.completedAt))
      .limit(1);

    if (!latest?.completedAt) {
      return {
        at: null,
        mattersReviewed: 0,
        issuesFound: 0,
        resolvedSince: 0,
      };
    }

    // Scope to the batch when there is one; otherwise just that job.
    const scope = latest.batchId
      ? eq(aiScanJobs.batchId, latest.batchId)
      : eq(aiScanJobs.completedAt, latest.completedAt);

    const [run] = await db
      .select({
        matters: countDistinct(
          sql`coalesce(${aiScanJobs.caseId}, ${aiScanJobs.leadId})`,
        ),
        issues: sql<number>`coalesce(sum(${aiScanJobs.issuesFound}), 0)::int`,
      })
      .from(aiScanJobs)
      .where(
        and(
          eq(aiScanJobs.organizationId, organizationId),
          eq(aiScanJobs.status, "complete"),
          scope,
        ),
      );

    const [resolvedSince] = await db
      .select({ n: count() })
      .from(caseIssues)
      .where(
        and(
          eq(caseIssues.organizationId, organizationId),
          eq(caseIssues.status, "resolved"),
          gte(caseIssues.resolvedAt, latest.completedAt),
        ),
      );

    return {
      at: latest.completedAt,
      mattersReviewed: run?.matters ?? 0,
      issuesFound: Number(run?.issues ?? 0),
      resolvedSince: resolvedSince.n,
    };
  };

  // ── List ──────────────────────────────────────────────────────────────────

  getIssues = async (
    organizationId: string,
    filters: {
      severity?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    const conditions = [eq(caseIssues.organizationId, organizationId)];
    if (filters.severity)
      conditions.push(eq(caseIssues.severity, filters.severity as IssueRow["severity"]));
    if (filters.status)
      conditions.push(eq(caseIssues.status, filters.status as IssueRow["status"]));
    else
      conditions.push(inArray(caseIssues.status, [...ACTIVE_STATUSES]));
    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(caseIssues)
      .where(where);

    const rows = await db
      .select(ISSUE_SELECT)
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, cases.caseTypeId),
      )
      .leftJoin(leads, eq(leads.id, caseIssues.leadId))
      .where(where)
      // Severity is a text enum, not ordinal — order by status then recency.
      .orderBy(desc(caseIssues.detectedAt))
      .limit(limit)
      .offset(offset);

    const language = await getFirmLanguage(organizationId);
    const items = rows.map((r) => presentIssue(flattenIssueRow(r), language));

    return buildPaginatedResponse(items, { page, limit, total: Number(total) });
  };

  // ── By matter ─────────────────────────────────────────────────────────────

  /**
   * "Issues by case" — AI detection status for every active matter, including
   * the ones with nothing wrong, which show as `Clear`.
   *
   * Leads are listed alongside cases: an issue attaches to either, so a
   * cases-only list would silently hide every intake-stage finding. Leads have
   * no case number, so their reference is null and the UI falls back to the
   * name.
   *
   * Written as one UNION so paging happens in Postgres. Merging two result sets
   * in memory would mean fetching every matter on every page.
   */
  getByCase = async (
    organizationId: string,
    filters: { page?: number; limit?: number },
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    const matters = sql`
      SELECT c.id,
             'case'  AS type,
             cl.display_name AS name,
             c.case_number   AS reference
        FROM ${cases} c
        JOIN ${clients} cl ON cl.id = c.client_id
       WHERE c.organization_id = ${organizationId}
         AND c.status = 'active'
       UNION ALL
      SELECT l.id,
             'lead'  AS type,
             concat(l.first_name, ' ', l.last_name) AS name,
             NULL    AS reference
        FROM ${leads} l
       WHERE l.organization_id = ${organizationId}
         AND l.status <> 'archived'
    `;

    const counts = sql`
      SELECT coalesce(case_id, lead_id) AS matter_id,
             count(*) FILTER (WHERE severity IN ('critical', 'high'))  AS critical,
             count(*) FILTER (WHERE severity IN ('medium', 'low'))     AS warnings
        FROM ${caseIssues}
       WHERE organization_id = ${organizationId}
         AND status IN ('open', 'under_review')
       GROUP BY 1
    `;

    const rows = await db.execute(sql`
      WITH matters AS (${matters}), counts AS (${counts})
      SELECT m.id,
             m.type,
             m.name,
             m.reference,
             coalesce(ct.critical, 0)::int AS critical,
             coalesce(ct.warnings, 0)::int AS warnings
        FROM matters m
        LEFT JOIN counts ct ON ct.matter_id = m.id
       ORDER BY m.name ASC
       LIMIT ${limit} OFFSET ${offset}
    `);

    const [totalRow] = (await db.execute(sql`
      WITH matters AS (${matters})
      SELECT count(*)::int AS total FROM matters
    `)) as unknown as { total: number }[];

    const items = (rows as unknown as MatterRow[]).map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      reference: r.reference,
      initials: initialsOf(r.name),
      critical: r.critical,
      warnings: r.warnings,
      /** `clear` drives the green pill for a matter with nothing outstanding. */
      status:
        r.critical > 0 ? "critical" : r.warnings > 0 ? "warning" : "clear",
    }));

    return buildPaginatedResponse(items, {
      page,
      limit,
      total: Number(totalRow?.total ?? 0),
    });
  };

  // ── By document ───────────────────────────────────────────────────────────

  /**
   * "Document flags" — every document an issue points at, plus every required
   * document that has not arrived.
   *
   * The second half is what makes this more than a join: the mockup lists rows
   * like "I-693 Medical exam — Missing", and a missing document has no
   * `documents` row to join to. Those come from unmet
   * `scenario_document_requirements` instead.
   */
  getByDocument = async (
    organizationId: string,
    filters: { page?: number; limit?: number },
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = getPaginationOffset({ page, limit });

    // Flagged documents: an issue names them, so they exist and have a version.
    const flagged = sql`
      SELECT DISTINCT ON (d.id, i.id)
             d.id                       AS document_id,
             i.id                       AS issue_id,
             d.title                    AS title,
             d.category::text           AS type,
             i.issue_type               AS issue_type,
             i.severity::text           AS severity,
             coalesce(cl.display_name, concat(l.first_name, ' ', l.last_name)) AS matter_name,
             cs.case_number             AS matter_reference,
             coalesce(i.case_id, i.lead_id) AS matter_id,
             CASE WHEN i.case_id IS NOT NULL THEN 'case' ELSE 'lead' END AS matter_type,
             CASE WHEN es.id IS NOT NULL THEN 'client_upload' ELSE 'firm' END AS source,
             dv.created_at              AS date
        FROM ${caseIssueDocuments} cid
        JOIN ${caseIssues} i        ON i.id = cid.issue_id
        JOIN ${documents} d         ON d.id = cid.document_id
        LEFT JOIN ${documentVersions} dv ON dv.id = d.current_version_id
        LEFT JOIN ${externalSubmissions} es ON es.document_id = d.id
        LEFT JOIN ${cases} cs       ON cs.id = i.case_id
        LEFT JOIN ${clients} cl     ON cl.id = i.client_id
        LEFT JOIN ${leads} l        ON l.id = i.lead_id
       WHERE i.organization_id = ${organizationId}
         AND i.status IN ('open', 'under_review')
         AND d.status = 'active'
    `;

    // Awaited documents: a requirement with nothing satisfying it yet.
    const awaited = sql`
      SELECT NULL::uuid                 AS document_id,
             NULL::uuid                 AS issue_id,
             r.label                    AS title,
             'required'                 AS type,
             'missing_required_document' AS issue_type,
             'critical'                 AS severity,
             coalesce(cl.display_name, concat(l.first_name, ' ', l.last_name)) AS matter_name,
             cs.case_number             AS matter_reference,
             coalesce(r.case_id, r.lead_id) AS matter_id,
             CASE WHEN r.case_id IS NOT NULL THEN 'case' ELSE 'lead' END AS matter_type,
             'pending_client'           AS source,
             NULL::timestamp            AS date
        FROM ${scenarioDocumentRequirements} r
        LEFT JOIN ${cases} cs   ON cs.id = r.case_id
        LEFT JOIN ${clients} cl ON cl.id = cs.client_id
        LEFT JOIN ${leads} l    ON l.id = r.lead_id
       WHERE r.organization_id = ${organizationId}
         AND r.is_required = true
         AND r.satisfied_by_document_id IS NULL
         AND r.waived_at IS NULL
    `;

    const combined = sql`SELECT * FROM (${flagged}) f UNION ALL SELECT * FROM (${awaited}) a`;

    const rows = (await db.execute(sql`
      SELECT * FROM (${combined}) rows
       ORDER BY date DESC NULLS LAST, title ASC
       LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as DocumentFlagRow[];

    const [totalRow] = (await db.execute(sql`
      SELECT count(*)::int AS total FROM (${combined}) rows
    `)) as unknown as { total: number }[];

    const items = rows.map((r) => ({
      documentId: r.document_id,
      issueId: r.issue_id,
      title: r.title,
      type: r.type,
      matter: {
        id: r.matter_id,
        type: r.matter_type,
        name: r.matter_name,
        reference: r.matter_reference,
      },
      source: r.source,
      date: r.date,
      // The short pill in the AI FLAG column — the issue's category, reused so
      // this view and the dashboard cards cannot disagree about naming.
      flag: issueCategory(r.issue_type),
      badge: severityBadge(r.severity),
    }));

    return buildPaginatedResponse(items, {
      page,
      limit,
      total: Number(totalRow?.total ?? 0),
    });
  };

  // ── Resolution log ────────────────────────────────────────────────────────

  /**
   * Everything resolved in the window, with who closed it and what they did.
   *
   * "Action taken" comes from the `actionKey` on the resolving event rather
   * than free text, so the label is rendered at read time in the firm's
   * language — the same treatment issue prose gets.
   */
  getResolutionLog = async (
    organizationId: string,
    filters: { page?: number; limit?: number; days?: number },
  ) => {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const days = filters.days ?? 30;
    const offset = getPaginationOffset({ page, limit });
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const where = and(
      eq(caseIssues.organizationId, organizationId),
      eq(caseIssues.status, "resolved"),
      gte(caseIssues.resolvedAt, since),
    );

    const [{ total }] = await db
      .select({ total: count() })
      .from(caseIssues)
      .where(where);

    // The event that closed it carries the action; there may be several events,
    // so take the most recent resolving one.
    const resolvingEvent = db
      .select({
        issueId: caseIssueEvents.issueId,
        actionKey: sql<string | null>`(array_agg(${caseIssueEvents.actionKey} ORDER BY ${caseIssueEvents.createdAt} DESC))[1]`.as(
          "action_key",
        ),
      })
      .from(caseIssueEvents)
      .where(eq(caseIssueEvents.toStatus, "resolved"))
      .groupBy(caseIssueEvents.issueId)
      .as("resolving_event");

    const rows = await db
      .select({
        issue: caseIssues,
        clientName: clients.displayName,
        caseTypeId: cases.caseTypeId,
        caseTypeName: practiceAreaCaseTypes.name,
        caseNumber: cases.caseNumber,
        leadName: sql<
          string | null
        >`concat(${leads.firstName}, ' ', ${leads.lastName})`,
        resolvedByName: sql<
          string | null
        >`concat(${staff.firstName}, ' ', ${staff.lastName})`,
        resolvedByRole: staff.role,
        actionKey: resolvingEvent.actionKey,
      })
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, cases.caseTypeId),
      )
      .leftJoin(leads, eq(leads.id, caseIssues.leadId))
      .leftJoin(staff, eq(staff.id, caseIssues.resolvedById))
      .leftJoin(resolvingEvent, eq(resolvingEvent.issueId, caseIssues.id))
      .where(where)
      .orderBy(desc(caseIssues.resolvedAt))
      .limit(limit)
      .offset(offset);

    // Banner: mean days from detection to resolution across the whole window,
    // not just the current page.
    const [avg] = await db
      .select({
        days: sql<
          number | null
        >`avg(extract(epoch from (${caseIssues.resolvedAt} - ${caseIssues.detectedAt})) / 86400.0)`,
      })
      .from(caseIssues)
      .where(where);

    const language = await getFirmLanguage(organizationId);
    const items = rows.map((r) => {
      const presented = presentIssue(flattenIssueRow(r), language);
      return {
        id: presented.id,
        title: presented.title,
        category: presented.category,
        scenario: presented.scenario,
        client: presented.client,
        resolvedAt: r.issue.resolvedAt,
        resolvedBy: r.resolvedByName
          ? { name: r.resolvedByName, role: r.resolvedByRole }
          : null,
        actionKey: r.actionKey,
        actionTaken: r.actionKey ? actionLabel(r.actionKey, language) : null,
      };
    });

    return {
      ...buildPaginatedResponse(items, {
        page,
        limit,
        total: Number(total),
      }),
      summary: {
        resolved: Number(total),
        averageResolutionDays:
          avg?.days != null ? Number(Number(avg.days).toFixed(1)) : null,
        windowDays: days,
      },
    };
  };

  // ── Detail ────────────────────────────────────────────────────────────────

  getIssueById = async (organizationId: string, id: string) => {
    const [row] = await db
      .select(ISSUE_SELECT)
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, cases.caseTypeId),
      )
      .leftJoin(leads, eq(leads.id, caseIssues.leadId))
      .where(and(eq(caseIssues.id, id), eq(caseIssues.organizationId, organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Issue not found");

    const language = await getFirmLanguage(organizationId);

    const docs = await db
      .select({
        documentId: caseIssueDocuments.documentId,
        role: caseIssueDocuments.role,
        title: documents.title,
      })
      .from(caseIssueDocuments)
      .leftJoin(documents, eq(documents.id, caseIssueDocuments.documentId))
      .where(eq(caseIssueDocuments.issueId, id));

    const events = await db
      .select()
      .from(caseIssueEvents)
      .where(eq(caseIssueEvents.issueId, id))
      .orderBy(caseIssueEvents.createdAt);

    return {
      ...presentIssue(flattenIssueRow(row), language),
      documents: docs,
      events,
    };
  };

  // ── Status actions (resolution log) ─────────────────────────────────────────

  updateStatus = async (
    organizationId: string,
    id: string,
    action: "resolve" | "dismiss" | "reopen" | "review",
    staffId: string | undefined,
    note?: string,
  ) => {
    const [existing] = await db
      .select({ id: caseIssues.id, status: caseIssues.status })
      .from(caseIssues)
      .where(and(eq(caseIssues.id, id), eq(caseIssues.organizationId, organizationId)))
      .limit(1);
    if (!existing) throw new NotFoundError("Issue not found");

    const now = new Date();
    const patch: Partial<IssueRow> = { updatedAt: now };
    let toStatus: IssueRow["status"];
    switch (action) {
      case "resolve":
        toStatus = "resolved";
        patch.status = "resolved";
        patch.resolvedById = staffId ?? null;
        patch.resolvedAt = now;
        break;
      case "dismiss":
        toStatus = "dismissed";
        patch.status = "dismissed";
        patch.dismissedById = staffId ?? null;
        patch.dismissedAt = now;
        break;
      case "review":
        toStatus = "under_review";
        patch.status = "under_review";
        break;
      case "reopen":
        toStatus = "open";
        patch.status = "open";
        patch.resolvedById = null;
        patch.resolvedAt = null;
        patch.dismissedById = null;
        patch.dismissedAt = null;
        patch.supersededAt = null;
        break;
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(caseIssues)
        .set(patch)
        .where(eq(caseIssues.id, id))
        .returning();
      await tx.insert(caseIssueEvents).values({
        issueId: id,
        fromStatus: existing.status,
        toStatus,
        actorStaffId: staffId ?? null,
        note: note ?? null,
      });
      return row;
    });

    const language = await getFirmLanguage(organizationId);
    return presentIssue(updated, language);
  };

  // ── Config ──────────────────────────────────────────────────────────────────

  getConfig = async (organizationId: string) => {
    const [row] = await db
      .select()
      .from(aiSystemConfig)
      .where(eq(aiSystemConfig.organizationId, organizationId))
      .limit(1);
    if (row) return row;
    const [created] = await db
      .insert(aiSystemConfig)
      .values({ organizationId })
      .returning();
    return created;
  };

  updateConfig = async (
    organizationId: string,
    data: Partial<typeof aiSystemConfig.$inferInsert>,
  ) => {
    await this.getConfig(organizationId); // ensure a row exists
    const [updated] = await db
      .update(aiSystemConfig)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(aiSystemConfig.organizationId, organizationId))
      .returning();
    return updated;
  };
}
