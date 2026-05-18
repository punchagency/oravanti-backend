import { and, eq } from 'drizzle-orm';
import { db } from '../../config/db';
import { dataAccessControls } from '../../db/schema/data-access-controls';

export const getDataAccessControls = async (firmId: string) => {
  const rows = await db
    .select()
    .from(dataAccessControls)
    .where(eq(dataAccessControls.firmId, firmId));

  return rows.reduce((acc, row) => {
    if (!acc[row.dataType]) acc[row.dataType] = {};
    acc[row.dataType][row.role] = row.permission;
    return acc;
  }, {} as Record<string, Record<string, string>>);
};

export const updateDataAccessControls = async (
  firmId: string,
  controls: { dataType: string; role: string; permission: string }[],
) => {
  await Promise.all(
    controls.map((c) =>
      db
        .update(dataAccessControls)
        .set({ permission: c.permission as any, updatedAt: new Date() })
        .where(
          and(
            eq(dataAccessControls.firmId,    firmId),
            eq(dataAccessControls.dataType,  c.dataType as any),
            eq(dataAccessControls.role,      c.role as any),
          ),
        ),
    ),
  );
};
