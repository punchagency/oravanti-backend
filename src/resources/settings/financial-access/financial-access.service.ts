import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { financialAccessControls } from "../../../db/schema";

export const getFinancialAccess = async (firmId: string) => {
  const rows = await db
    .select()
    .from(financialAccessControls)
    .where(eq(financialAccessControls.firmId, firmId));

  return rows.reduce(
    (acc, row) => {
      if (!acc[row.accountType]) acc[row.accountType] = {};
      acc[row.accountType][row.role] = row.permission;
      return acc;
    },
    {} as Record<string, Record<string, string>>,
  );
};

export const updateFinancialAccess = async (
  firmId: string,
  controls: { accountType: string; role: string; permission: string }[],
) => {
  await Promise.all(
    controls.map((c) =>
      db
        .update(financialAccessControls)
        .set({ permission: c.permission as any, updatedAt: new Date() })
        .where(
          and(
            eq(financialAccessControls.firmId, firmId),
            eq(financialAccessControls.accountType, c.accountType as any),
            eq(financialAccessControls.role, c.role as any),
          ),
        ),
    ),
  );
};
