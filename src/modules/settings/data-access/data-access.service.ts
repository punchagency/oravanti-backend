import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { dataAccessControls } from "../../../db/schema";

export class DataAccessService {
  getDataAccessControls = async (organizationId: string) => {
    const rows = await db
      .select()
      .from(dataAccessControls)
      .where(eq(dataAccessControls.organizationId, organizationId));

    return rows.reduce(
      (acc, row) => {
        if (!acc[row.dataType]) acc[row.dataType] = {};
        acc[row.dataType][row.role] = row.permission;
        return acc;
      },
      {} as Record<string, Record<string, string>>,
    );
  };

  updateDataAccessControls = async (
    organizationId: string,
    controls: { dataType: string; role: string; permission: string }[],
  ) => {
    await Promise.all(
      controls.map((c) =>
        db
          .update(dataAccessControls)
          .set({ permission: c.permission as any, updatedAt: new Date() })
          .where(
            and(
              eq(dataAccessControls.organizationId, organizationId),
              eq(dataAccessControls.dataType, c.dataType as any),
              eq(dataAccessControls.role, c.role as any),
            ),
          ),
      ),
    );
  };
}
