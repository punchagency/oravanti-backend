import { and, eq } from "drizzle-orm";
import { Response } from "express";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { leads } from "../../db/schema/leads";
import { AuthRequest } from "../../middleware/auth.middleware";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { enqueueFullScan, enqueueScenarioScan } from "./scan-producer";

export class AiScanController {
  /**
   * Manually (re-)scan one scenario. Runs immediately (no debounce) since a
   * human explicitly asked for it. Coalesces if a scan is already in flight.
   */
  rerunScenario = async (req: AuthRequest, res: Response) => {
    const { scenarioType, scenarioId } = req.body as {
      scenarioType: "lead" | "case";
      scenarioId: string;
    };
    const organizationId = req.organizationId!;

    // scenarioId comes from the request body — verify it belongs to this firm
    // before scanning. Access here is application-level, not RLS-enforced.
    const table = scenarioType === "lead" ? leads : cases;
    const [owned] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, scenarioId), eq(table.organizationId, organizationId)))
      .limit(1);
    if (!owned) throw new NotFoundError(`${scenarioType} not found`);

    const result = await enqueueScenarioScan({
      organizationId,
      scenarioType,
      scenarioId,
      trigger: "manual",
      requestedByStaffId: req.staffId,
      debounceMs: 0,
    });

    sendSuccess(res, result, "Scan requested");
  };

  /** Fan out a scan across every scenario in the firm that has documents. */
  runFullScan = async (req: AuthRequest, res: Response) => {
    const result = await enqueueFullScan(req.organizationId!, req.staffId);
    sendSuccess(res, result, "Full scan started");
  };
}
