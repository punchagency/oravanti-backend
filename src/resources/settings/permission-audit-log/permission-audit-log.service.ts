import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { admins, permissionAuditLog } from "../../../db/schema";

export class PermissionAuditLogService {
  getPermissionAuditLog = async (organizationId: string, limit = 20) => {
    return db
      .select()
      .from(permissionAuditLog)
      .where(eq(permissionAuditLog.organizationId, organizationId))
      .orderBy(desc(permissionAuditLog.createdAt))
      .limit(limit);
  };

  logPermissionChange = async (
    action: string,
    userId: string,
    organizationId: string,
  ) => {
    const adminRecord = await db
      .select({ firstName: admins.firstName, lastName: admins.lastName })
      .from(admins)
      .where(and(eq(admins.userId, userId), eq(admins.organizationId, organizationId)))
      .limit(1);

    const changedByName = adminRecord.length
      ? `${adminRecord[0].firstName} ${adminRecord[0].lastName}`
      : "Unknown Admin";

    await db.insert(permissionAuditLog).values({
      organizationId,
      action,
      changedBy: userId,
      changedByName,
      changedByRole: "admin",
    });
  };
}
