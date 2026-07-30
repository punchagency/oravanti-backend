import { and, count, countDistinct, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
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
import {
  BadRequestError,
  NotFoundError,
  NotImplementedError,
} from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
import {
  actionLabel,
  findAction,
  isActionAllowed,
  isStubAction,
  presentActions,
} from "./actions";
import {
  defaultActionDeps,
  dispatchAction,
  loadIssueForAction,
  type ActionDeps,
} from "./action-dispatch";
import { eligibleAssignees, resolveAssignee } from "./assignees";
import {
  documentFlagLabel,
  issueCategory,
  renderIssue,
  severityBadge,
} from "./render";
import {
  renderReport,
  type ExportFormat,
  type ReportColumn,
} from "../../utils/report-export";

/** Why an assignee-taking action could not run, in words a reviewer can act on. */
const ASSIGNEE_ERRORS = {
  none:
    "No eligible attorney to assign. A case assigned to a team can only be " +
    "routed to an attorney on that team.",
  ambiguous: "Choose an attorney to assign this to",
  ineligible: "That staff member cannot be assigned this issue",
} as const;

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
    actions: presentActions(row.issueType, row.leadId ? "lead" : "case"),
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
      leadId?: string;
      caseId?: string;
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
    // Scope to one matter, for the per-matter tab.
    if (filters.leadId) conditions.push(eq(caseIssues.leadId, filters.leadId));
    if (filters.caseId) conditions.push(eq(caseIssues.caseId, filters.caseId));
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
      issueType: r.issue_type,
      // Short label for the AI FLAG column ("Expiry risk", "Missing", …).
      flag: documentFlagLabel(r.issue_type),
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

  // ── Exports ─────────────────────────────────────────────────────────────────

  /**
   * Upper bound on rows an export returns. Exports are a spreadsheet dump, not a
   * data feed — a firm with more active issues than this has a bigger problem
   * than pagination, and an unbounded query would risk the process.
   */
  private static readonly EXPORT_MAX = 5000;

  /** The active issues list, honouring the same filters as `getIssues`. */
  exportIssues = async (
    organizationId: string,
    filters: { severity?: string; status?: string },
    format: ExportFormat,
  ) => {
    const page = await this.getIssues(organizationId, {
      ...filters,
      page: 1,
      limit: CaseReviewService.EXPORT_MAX,
    });

    type Issue = (typeof page.data)[number];
    const columns: ReportColumn<Issue>[] = [
      { header: "Severity", value: (i) => i.severity, weight: 0.8 },
      { header: "Category", value: (i) => i.category },
      { header: "Title", value: (i) => i.title, weight: 2.5 },
      { header: "Status", value: (i) => i.status },
      { header: "Client", value: (i) => i.client?.name ?? "", weight: 1.4 },
      { header: "Matter", value: (i) => i.scenario.reference ?? "" },
      { header: "Matter type", value: (i) => i.scenario.type, weight: 0.8 },
      { header: "Detected", value: (i) => i.detectedAt },
    ];

    const report = await renderReport(format, page.data, columns, {
      title: "AI case review — active issues",
      subtitle: `${page.data.length} issue(s) · exported ${new Date().toISOString().slice(0, 10)}`,
    });

    return {
      filename: `ai-review-issues.${report.extension}`,
      mime: report.mime,
      body: report.body,
    };
  };

  /** The resolution log, honouring the same window as `getResolutionLog`. */
  exportResolutionLog = async (
    organizationId: string,
    filters: { days?: number },
    format: ExportFormat,
  ) => {
    const page = await this.getResolutionLog(organizationId, {
      ...filters,
      page: 1,
      limit: CaseReviewService.EXPORT_MAX,
    });

    type LogRow = (typeof page.data)[number];
    const columns: ReportColumn<LogRow>[] = [
      { header: "Issue", value: (r) => r.title, weight: 2.5 },
      { header: "Client", value: (r) => r.client?.name ?? "", weight: 1.4 },
      { header: "Matter", value: (r) => r.scenario.reference ?? "" },
      { header: "Resolved by", value: (r) => r.resolvedBy?.name ?? "", weight: 1.4 },
      { header: "Role", value: (r) => r.resolvedBy?.role ?? "" },
      { header: "Resolved date", value: (r) => r.resolvedAt },
      { header: "Action taken", value: (r) => r.actionTaken ?? "", weight: 1.4 },
    ];

    const report = await renderReport(format, page.data, columns, {
      title: "AI case review — resolution log",
      subtitle: `${page.summary.resolved} resolved · avg ${page.summary.averageResolutionDays ?? "—"} day(s)`,
    });

    return {
      filename: `ai-review-resolution-log.${report.extension}`,
      mime: report.mime,
      body: report.body,
    };
  };

  // ── Contextual actions ──────────────────────────────────────────────────────

  /**
   * Run a contextual action against an issue: check it is one the issue offers,
   * perform its effect, then record a `case_issue_events` row carrying the
   * action key (what the resolution log reads) and move the issue to
   * `under_review` so a mutation shows up as being worked.
   *
   * Navigate actions return where to go and change nothing.
   */
  /**
   * The attorneys an issue's assignee-taking actions may route work to.
   *
   * Scoped by the issue's own matter, so a case committed to a team offers only
   * that team — the picker and the dispatch must agree on who is eligible.
   */
  getEligibleAssignees = async (organizationId: string, id: string) => {
    const issue = await loadIssueForAction(organizationId, id);
    if (!issue) throw new NotFoundError("Issue not found");
    return eligibleAssignees({ organizationId, caseId: issue.caseId });
  };

  /**
   * `ctx` is an object rather than trailing positional arguments: the mix of
   * "who acted", "who it is for" and the injected deps is too easy to transpose.
   */
  runAction = async (
    organizationId: string,
    id: string,
    actionKey: string,
    ctx: {
      /** The staff member performing the action, for the event trail. */
      staffId?: string;
      /** The attorney chosen to receive the work. */
      assigneeStaffId?: string;
      /** The signed-in user, recorded as a document request's requester. */
      actorUserId?: string;
      deps?: ActionDeps;
    } = {},
  ) => {
    const { staffId, assigneeStaffId, actorUserId, deps = defaultActionDeps } = ctx;
    const issue = await loadIssueForAction(organizationId, id);
    if (!issue) throw new NotFoundError("Issue not found");

    const scenarioType: "lead" | "case" = issue.leadId ? "lead" : "case";
    if (!isActionAllowed(issue.issueType, scenarioType, actionKey)) {
      throw new BadRequestError(
        `Action '${actionKey}' is not available for this issue`,
      );
    }
    const action = findAction(actionKey)!;

    // An offered-but-unbuilt action: the UI shows it disabled, but refuse it
    // here too rather than record an event for something that did not happen.
    if (isStubAction(action, scenarioType)) {
      throw new NotImplementedError(
        `'${action.label}' is not yet available for this matter type`,
      );
    }

    // Resolve the assignee before doing anything: a task nobody can act on is
    // worse than a refused action, so an unassignable issue fails loudly rather
    // than falling back to whoever clicked.
    let assignee: string | undefined;
    if (action.requiresAssignee) {
      const resolved = await resolveAssignee(
        { organizationId, caseId: issue.caseId },
        assigneeStaffId,
      );
      if (!resolved.ok) throw new BadRequestError(ASSIGNEE_ERRORS[resolved.reason]);
      assignee = resolved.staffId;
    }

    const result = await dispatchAction(deps, issue, action, {
      assigneeStaffId: assignee,
      staffId,
      actorUserId,
    });

    if (result.kind === "navigate") {
      return result;
    }

    // Record the action and mark the issue as being worked. A terminal issue
    // (resolved / dismissed / superseded) is left as-is — acting on it should
    // not silently reopen it.
    const active = issue.status === "open" || issue.status === "under_review";
    await withTransaction(db, async () => {
      if (active && issue.status !== "under_review") {
        await db
          .update(caseIssues)
          .set({ status: "under_review", updatedAt: new Date() })
          .where(eq(caseIssues.id, id));
      }
      await db.insert(caseIssueEvents).values({
        issueId: id,
        fromStatus: issue.status,
        toStatus: active ? "under_review" : issue.status,
        actorStaffId: staffId ?? null,
        actionKey,
      });
    });

    const language = await getFirmLanguage(organizationId);
    const [refreshed] = await db
      .select(ISSUE_SELECT)
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.id, cases.caseTypeId),
      )
      .leftJoin(leads, eq(leads.id, caseIssues.leadId))
      .where(eq(caseIssues.id, id));

    return {
      kind: "mutation" as const,
      issue: presentIssue(flattenIssueRow(refreshed), language),
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

    const updated = await withTransaction(db, async () => {
      const [row] = await db
        .update(caseIssues)
        .set(patch)
        .where(eq(caseIssues.id, id))
        .returning();
      await db.insert(caseIssueEvents).values({
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
