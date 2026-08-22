import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import {
  renderReport,
  type ExportFormat,
  type ReportColumn,
} from "../../utils/report-export";
import { sendSuccess } from "../../utils/send-success";
import { recordAccessEvent } from "../shared/audit.service";
import {
  AuditService,
  type AuditEventDTO,
  type ListAuditEventsFilters,
} from "./audit.service";

/**
 * Reading the audit trail is itself an audited act.
 *
 * Every handler here records an access event before it answers. A trail whose
 * readers are invisible answers "what happened" but not "who went looking",
 * and the second question is the one asked after an incident.
 */
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  /**
   * Query params arrive validated but typed as `unknown` by Express, so this
   * is the one place the shapes are asserted. Doing it once keeps the casts
   * out of every handler.
   */
  private filtersFrom = (query: Request["query"]): ListAuditEventsFilters => ({
    category: query.category as ListAuditEventsFilters["category"],
    action: query.action as string | undefined,
    domain: query.domain as string | undefined,
    entityType: query.entityType as string | undefined,
    entityId: query.entityId as string | undefined,
    actorId: query.actorId as string | undefined,
    actorStaffId: query.actorStaffId as string | undefined,
    from: query.from ? new Date(query.from as string) : undefined,
    to: query.to ? new Date(query.to as string) : undefined,
    search: query.search as string | undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    page: query.page ? Number(query.page) : undefined,
  });

  listEvents = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const filters = this.filtersFrom(req.query);
    const result = await this.svc.listEvents(organizationId!, filters);

    // Deduplicated to one row per reader per five minutes by the writer, so
    // paging through the log does not produce a page of rows per page read.
    await recordAccessEvent({
      action: "audit_log.viewed",
      entityId: organizationId,
      metadata: { filters },
    });

    sendSuccess(res, result.data, "Audit events retrieved", 200, {
      pagination: result.pagination,
    });
  };

  /** What this firm's trail actually contains, for populating filter controls. */
  getFacets = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const facets = await this.svc.getFilterFacets(organizationId!);
    sendSuccess(res, facets, "Audit filters retrieved");
  };

  /** One entity's activity — changes and views together. */
  listForEntity = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const entityType = req.params.entityType as string;
    const entityId = req.params.entityId as string;

    const result = await this.svc.listForEntity(
      organizationId!,
      entityType,
      entityId,
      {
        category: req.query.category as ListAuditEventsFilters["category"],
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor as string | undefined,
      },
    );

    sendSuccess(res, result.data, "Entity activity retrieved", 200, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  };

  /** Everything one request did, by correlation id. */
  listByRequestId = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const events = await this.svc.listByRequestId(
      organizationId!,
      req.params.requestId as string,
    );
    sendSuccess(res, events, "Request activity retrieved");
  };

  /**
   * The exported columns.
   *
   * `before`/`after` are deliberately absent: they hold the changed fields of
   * client matters, and a spreadsheet that leaves the building is the wrong
   * carrier for them. Whoever needs that detail can read the row in the app,
   * which records that they did.
   */
  private static readonly exportColumns: ReportColumn<AuditEventDTO>[] = [
    { header: "When", value: (r) => r.occurredAt, weight: 1.4 },
    { header: "Action", value: (r) => r.label, weight: 1.2 },
    { header: "Category", value: (r) => r.category },
    { header: "Summary", value: (r) => r.summary, weight: 3 },
    { header: "Actor", value: (r) => r.actorName, weight: 1.2 },
    { header: "Actor type", value: (r) => r.actorType },
    { header: "Entity", value: (r) => r.entityType },
    { header: "Entity ID", value: (r) => r.entityId, weight: 1.6 },
    { header: "IP address", value: (r) => r.ipAddress },
    { header: "Request ID", value: (r) => r.requestId, weight: 1.6 },
  ];

  exportEvents = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const format = ((req.query.format as string) ?? "csv") as ExportFormat;
    const filters = this.filtersFrom(req.query);

    const rows = await this.svc.exportEvents(organizationId!, filters);
    const report = await renderReport(
      format,
      rows,
      AuditController.exportColumns,
      {
        title: "Audit trail",
        subtitle: `${rows.length} event${rows.length === 1 ? "" : "s"}`,
      },
    );

    // `dedupeWindowMs: 0` — every export is a copy of firm records leaving the
    // system, so each one is recorded even if the same person exports twice in
    // a minute.
    await recordAccessEvent({
      action: "audit_log.exported",
      entityId: organizationId,
      summary: `Audit trail exported as ${format} (${rows.length} events)`,
      metadata: { format, rowCount: rows.length, filters },
      dedupeWindowMs: 0,
    });

    res.setHeader("Content-Type", report.mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-trail.${report.extension}"`,
    );
    res.send(report.body);
  };
}
