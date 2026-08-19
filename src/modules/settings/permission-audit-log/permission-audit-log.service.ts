import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/client";
import { auditEvents } from "../../../db/schema";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("permission-audit-log.service");

const PERMISSION_AUDIT_ACTIONS = [
  "admin.permission_changed",
  "admin.access_control_changed",
  "admin.data_access_changed",
  "admin.financial_access_changed",
  "admin.approval_workflow_changed",
  "admin.certification_gate_changed",
] as const;

export class PermissionAuditLogService {
  getPermissionAuditLog = async (organizationId: string, limit = 20) => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, organizationId),
          inArray(auditEvents.action, [...PERMISSION_AUDIT_ACTIONS]),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(limit);

    log.debug("permission_audit.queried", { organizationId, count: rows.length });

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      action: row.summary,
      changedBy: row.actorStaffId ?? row.actorId,
      changedByName: row.actorName,
      changedByRole: "admin",
      createdAt: row.occurredAt,
    }));
  };

  logPermissionChange = async (
    action: string,
    userId: string,
    organizationId: string,
  ) => {
    await recordAuditEvent({
      action: "admin.permission_changed",
      organizationId,
      summary: action,
      actor: { id: userId },
      onWriteFailure: "log",
    });
  };
}
