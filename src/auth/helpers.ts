import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { member, organization } from "../db/schema/auth-schema";

export async function getActiveOrganization(userId: string) {
  const [memberUser] = await db
    .select()
    .from(member)
    .where(eq(member.userId, userId));

  if (!memberUser) {
    return null;
  }

  const [activeOrganization] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, memberUser.organizationId));

  return activeOrganization;
}
