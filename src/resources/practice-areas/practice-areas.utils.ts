import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { practiceAreas } from "../../db/schema/practice-areas";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export const normalizePracticeAreaName = (name: string) => name.trim();

export const ensurePracticeAreaExists = async (
  firmId: string,
  practiceAreaId?: string,
) => {
  if (!practiceAreaId) {
    throw new BadRequestError("practiceAreaId is required");
  }

  const [practiceArea] = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(
      and(
        eq(practiceAreas.id, practiceAreaId),
        eq(practiceAreas.firmId, firmId),
      ),
    );

  if (!practiceArea) {
    throw new NotFoundError("Practice area not found");
  }

  return practiceArea;
};
