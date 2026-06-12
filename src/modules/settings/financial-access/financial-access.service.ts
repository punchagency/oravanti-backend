import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { financialAccessControls } from "../../../db/schema";

export class FinancialAccessService {
  getFinancialAccess = async (organizationId: string) => {
    const rows = await db
      .select()
      .from(financialAccessControls)
      .where(eq(financialAccessControls.organizationId, organizationId));

    return rows.reduce(
      (acc, row) => {
        if (!acc[row.accountType]) acc[row.accountType] = {};
        acc[row.accountType][row.role] = row.permission;
        return acc;
      },
      {} as Record<string, Record<string, string>>,
    );
  };

  updateFinancialAccess = async (
    organizationId: string,
    controls: { accountType: string; role: string; permission: string }[],
  ) => {
    await Promise.all(
      controls.map((c) =>
        db
          .update(financialAccessControls)
          .set({ permission: c.permission as any, updatedAt: new Date() })
          .where(
            and(
              eq(financialAccessControls.organizationId, organizationId),
              eq(financialAccessControls.accountType, c.accountType as any),
              eq(financialAccessControls.role, c.role as any),
            ),
          ),
      ),
    );
  };
}
