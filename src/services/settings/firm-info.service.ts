import { db } from '../../config/db';
import { firms } from '../../db/schema/firm-info';
import { UpsertFirmInfoBody } from '../../types/settings.types';
import { eq } from 'drizzle-orm';

export const getFirmInfo = async (firmId: string) => {
  const result = await db.select().from(firms).where(eq(firms.id, firmId));
  return result[0] ?? null;
};

export const upsertFirmInfo = async (firmId: string, body: UpsertFirmInfoBody) => {
  const existing = await getFirmInfo(firmId);

  if (existing) {
    const [updated] = await db
      .update(firms)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(firms.id, firmId))
      .returning();
    return updated;
  }

  const [created] = await db.insert(firms).values({ id: firmId, ...body }).returning();
  return created;
};
