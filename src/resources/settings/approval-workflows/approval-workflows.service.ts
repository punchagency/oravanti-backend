import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { approvalWorkflows } from "../../../db/schema";

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
  };
}
