import { desc, eq, and } from 'drizzle-orm';
import { db } from '../../config/db';
import { permissionAuditLog } from '../../db/schema/permission-audit-log';
import { admins } from '../../db/schema/admins';

export const getPermissionAuditLog = async (firmId: string, limit = 20) => {
  return db
    .select()
    .from(permissionAuditLog)
    .where(eq(permissionAuditLog.firmId, firmId))
    .orderBy(desc(permissionAuditLog.createdAt))
    .limit(limit);
};

export const logPermissionChange = async (action: string, userId: string, firmId: string) => {
  const adminRecord = await db
    .select({ firstName: admins.firstName, lastName: admins.lastName })
    .from(admins)
    .where(and(eq(admins.userId, userId), eq(admins.firmId, firmId)))
    .limit(1);

  const changedByName = adminRecord.length
    ? `${adminRecord[0].firstName} ${adminRecord[0].lastName}`
    : 'Unknown Admin';

  await db.insert(permissionAuditLog).values({
    firmId,
    action,
    changedBy:     userId,
    changedByName,
    changedByRole: 'admin',
  });
};
