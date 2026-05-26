import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { firms } from "../../../db/schema";
import { UpsertFirmInfoBody } from "../../../types/settings.types";

export const getFirmInfo = async (firmId: string) => {
  const result = await db.select().from(firms).where(eq(firms.id, firmId));
  return result[0] ?? null;
};

export const upsertFirmInfo = async (
  firmId: string,
  body: UpsertFirmInfoBody,
) => {
  const existing = await getFirmInfo(firmId);

  if (existing) {
    const [updated] = await db
      .update(firms)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(firms.id, firmId))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(firms)
    .values({ id: firmId, ...body })
    .returning();
  return created;
};
