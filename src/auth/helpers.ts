import { eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { member, organization } from "../db/schema/auth-schema";

export async function getActiveOrganization(userId: string) {
  const [memberUser] = await systemDb
    .select()
    .from(member)
    .where(eq(member.userId, userId));

  if (!memberUser) {
    return null;
  }

  const [activeOrganization] = await systemDb
    .select()
    .from(organization)
    .where(eq(organization.id, memberUser.organizationId));

  return activeOrganization;
}
