import { and, count, countDistinct, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
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
import { getFirmLanguage } from "../settings/consultation/consultation-settings.service";
import { renderIssue, severityBadge } from "./render";

const CRITICAL_SEVERITIES = ["critical", "high"] as const;
const WARNING_SEVERITIES = ["medium", "low"] as const;
const ACTIVE_STATUSES = ["open", "under_review"] as const;

type IssueRow = typeof caseIssues.$inferSelect;

const scenarioOf = (row: Pick<IssueRow, "leadId" | "caseId">) =>
  row.leadId
    ? { type: "lead" as const, id: row.leadId }
    : { type: "case" as const, id: row.caseId! };

const presentIssue = (
  row: IssueRow & { clientName?: string | null; caseTypeId?: string | null },
  language: string,
) => {
  const prose = renderIssue(
    row.templateKey,
    (row.templateParams as Record<string, unknown>) ?? {},
    language,
  );
  return {
    id: row.id,
    issueType: row.issueType,
    source: row.source,
    severity: row.severity,
    badge: severityBadge(row.severity),
    status: row.status,
    ...prose,
    affectedField: row.affectedField,
    scenario: scenarioOf(row),
    client: row.clientId ? { id: row.clientId, name: row.clientName ?? "" } : null,
    caseTypeId: row.caseTypeId ?? null,
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

    return {
      criticalIssues: critical.n,
      warnings: warnings.n,
      mattersAffected: affected.n,
      resolvedLast30Days: resolved.n,
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
      .select({
        issue: caseIssues,
        clientName: clients.displayName,
        caseTypeId: cases.caseTypeId,
      })
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
      .where(where)
      // Severity is a text enum, not ordinal — order by status then recency.
      .orderBy(desc(caseIssues.detectedAt))
      .limit(limit)
      .offset(offset);

    const language = await getFirmLanguage(organizationId);
    const items = rows.map((r) =>
      presentIssue({ ...r.issue, clientName: r.clientName, caseTypeId: r.caseTypeId }, language),
    );

    return buildPaginatedResponse(items, { page, limit, total: Number(total) });
  };

  // ── Detail ────────────────────────────────────────────────────────────────

  getIssueById = async (organizationId: string, id: string) => {
    const [row] = await db
      .select({
        issue: caseIssues,
        clientName: clients.displayName,
        caseTypeId: cases.caseTypeId,
      })
      .from(caseIssues)
      .leftJoin(clients, eq(clients.id, caseIssues.clientId))
      .leftJoin(cases, eq(cases.id, caseIssues.caseId))
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
      ...presentIssue(
        { ...row.issue, clientName: row.clientName, caseTypeId: row.caseTypeId },
        language,
      ),
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
