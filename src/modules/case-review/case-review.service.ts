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
import { documents } from "../../db/schema/documents";
import { leads } from "../../db/schema/leads";
import { NotFoundError } from "../../utils/error/app-error";
import {
  buildPaginatedResponse,
  getPaginationOffset,
} from "../../utils/pagination";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
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
