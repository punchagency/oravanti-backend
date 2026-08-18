import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { approvalWorkflows } from "../../../db/schema";
import { recordAuditEvent } from "../../shared/audit.service";
import { createModuleLogger } from "../../../lib/logging/log";

const log = createModuleLogger("approval-workflows.service");

export class ApprovalWorkflowsService {
  getApprovalWorkflows = async (organizationId: string) => {
    return db
      .select()
      .from(approvalWorkflows)
      .where(eq(approvalWorkflows.organizationId, organizationId));
  };

  updateApprovalWorkflows = async (
    organizationId: string,
    workflows: {
      workflowType: string;
      chain?: string;
      isRequired?: boolean;
      allowBypass?: boolean;
    }[],
  ) => {
    await Promise.all(
      workflows.map((w) =>
        db
          .update(approvalWorkflows)
          .set({
            ...(w.chain !== undefined && { chain: w.chain }),
            ...(w.isRequired !== undefined && { isRequired: w.isRequired }),
            ...(w.allowBypass !== undefined && { allowBypass: w.allowBypass }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(approvalWorkflows.organizationId, organizationId),
              eq(approvalWorkflows.workflowType, w.workflowType as any),
            ),
          ),
      ),
    );
    await recordAuditEvent({
      action: "admin.approval_workflow_changed",
      entityId: organizationId,
      entityType: "permission",
      onWriteFailure: "log",
    });
    log.action("settings.approval_workflow_updated", { organizationId });
  };
}
