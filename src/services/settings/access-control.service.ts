import { count, inArray, eq, and } from 'drizzle-orm';
import { db } from '../../config/db';
import { staff } from '../../db/schema/staff';
import { clients } from '../../db/schema/clients';
import { modulePermissions } from '../../db/schema/module-permissions';

export const getRoleOverview = async (firmId: string) => {
  const [adminCount, attorneyCount, paralegalCount, clientCount] = await Promise.all([
    db.select({ count: count() }).from(staff).where(and(eq(staff.firmId, firmId), eq(staff.role, 'admin'))),
    db.select({ count: count() }).from(staff).where(and(eq(staff.firmId, firmId), eq(staff.role, 'attorney'))),
    db.select({ count: count() }).from(staff).where(
      and(eq(staff.firmId, firmId), inArray(staff.role, ['junior_paralegal', 'paralegal', 'senior_paralegal']))
    ),
    db.select({ count: count() }).from(clients).where(eq(clients.firmId, firmId)),
  ]);

  return {
    admin:     { count: adminCount[0].count,     description: 'Full system access'    },
    attorney:  { count: attorneyCount[0].count,  description: 'Review & approve cases' },
    paralegal: { count: paralegalCount[0].count, description: 'Case preparation'       },
    client:    { count: clientCount[0].count,    description: 'Limited portal access'  },
  };
};

export const getPermissions = async (firmId: string) => {
  const rows = await db.select().from(modulePermissions).where(eq(modulePermissions.firmId, firmId));

  return rows.reduce((acc, row) => {
    if (!acc[row.module]) acc[row.module] = {};
    acc[row.module][row.role] = row.permission;
    return acc;
  }, {} as Record<string, Record<string, string>>);
};

export const savePermissions = async (
  firmId: string,
  permissions: { module: string; role: string; permission: string }[],
) => {
  await Promise.all(
    permissions.map((p) =>
      db
        .update(modulePermissions)
        .set({ permission: p.permission as any, updatedAt: new Date() })
        .where(
          and(
            eq(modulePermissions.firmId, firmId),
            eq(modulePermissions.module, p.module as any),
            eq(modulePermissions.role,   p.role as any),
          ),
        ),
    ),
  );
};
